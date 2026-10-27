#!/usr/bin/env python3
"""Exercise word-edit bytes against a local Bash Readline PTY; no SSH required."""
import os
import select
import shutil
import subprocess
import sys
import time

if os.name != "posix" or not shutil.which("bash"):
    print("SKIP: local POSIX PTY and Bash required")
    sys.exit(0)

import pty


def receive(fd, marker):
    data = b""
    deadline = time.monotonic() + 5
    while marker not in data and time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data += os.read(fd, 65536)
            except OSError:
                break
    assert marker in data, repr(data)
    return data


cases = [
    ("left", b"one two three\x1bbX\r", b"one two Xthree"),
    ("right", b"one two three\x01\x1bfX\r", b"oneX two three"),
    ("backward delete", b"one two three\x1b\x7f\r", b"one two "),
    ("forward delete", b"one two three\x01\x1bd\r", b" two three"),
    ("middle edit", b"one two three\x1bb\x1b\x7fNEW \x05\r", b"one NEW three"),
    # Ctrl+W（unix-word-rubout）与 terminalLineModel.applyLineEditControlChar
    # 的语义对照：删「行尾空白 + 最后一个词」，保留词前的分隔空白。
    ("ctrl-w word", b"abc def\x17\r", b"abc "),
    ("ctrl-w multiple trailing spaces", b"abc  def  \x17\r", b"abc  "),
    ("ctrl-w trailing blank only", b"abc \x17\r", b""),
    ("ctrl-w blank line", b"   \x17\r", b""),
    ("ctrl-w quoted word", b"'a b'\x17\r", b"'a "),
]
for name, keys, expected in cases:
    master, slave = pty.openpty()
    process = subprocess.Popen(
        ["bash", "--noprofile", "--norc", "-c",
         'set -o emacs; IFS= read -e -r -p "READY> " line; printf "\\nRESULT:<%s>\\n" "$line"'],
        stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, "INPUTRC": "/dev/null", "TERM": "xterm-256color"},
    )
    os.close(slave)
    try:
        receive(master, b"READY> ")
        os.write(master, keys)
        receive(master, b"RESULT:<" + expected + b">")
        assert process.wait(timeout=5) == 0
        print(f"PASS: {name}")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
