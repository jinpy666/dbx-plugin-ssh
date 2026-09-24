// grep 结构化补全数据（日志检索高频）。
//
// 数据来源：man 1 grep 常用项，格式借鉴 fig 完成规范的 command/option/args
// 三层思路。裁剪原则：高频 flag；pattern 与文件路径动态。
import type { SpecCommand } from "../spec";

export const grepSpec: SpecCommand = {
  name: "grep",
  description: "Print lines matching a pattern",
  flags: [
    { name: "ignore-case", short: "i", description: "Case-insensitive match" },
    { name: "invert-match", short: "v", description: "Select non-matching lines" },
    { name: "recursive", short: "r", description: "Read directories recursively" },
    { name: "dereference-recursive", short: "R", description: "Recursive, following symlinks" },
    { name: "line-number", short: "n", description: "Prefix lines with line numbers" },
    { name: "files-with-matches", short: "l", description: "Print only matching file names" },
    { name: "files-without-match", short: "L", description: "Print only non-matching file names" },
    { name: "count", short: "c", description: "Print match counts per file" },
    { name: "word-regexp", short: "w", description: "Match whole words only" },
    { name: "line-regexp", short: "x", description: "Match whole lines only" },
    { name: "extended-regexp", short: "E", description: "Extended regex (egrep)" },
    { name: "fixed-strings", short: "F", description: "Pattern is a literal string (fgrep)" },
    { name: "basic-regexp", short: "G", description: "Basic regex (default)" },
    { name: "perl-regexp", short: "P", description: "Perl-compatible regex" },
    { name: "regexp", short: "e", description: "Pattern (repeatable)", arg: "pattern" },
    { name: "file", short: "f", description: "Read patterns from a file", arg: "file" },
    { name: "after-context", short: "A", description: "Lines of trailing context", arg: "num" },
    { name: "before-context", short: "B", description: "Lines of leading context", arg: "num" },
    { name: "context", short: "C", description: "Lines of context around", arg: "num" },
    { name: "only-matching", short: "o", description: "Print only the matched parts" },
    { name: "with-filename", short: "H", description: "Prefix matches with file names" },
    { name: "no-filename", short: "h", description: "Suppress file name prefixes" },
    { name: "include", description: "Search only matching files (with -r)", arg: "glob" },
    { name: "exclude", description: "Skip matching files (with -r)", arg: "glob" },
    { name: "exclude-dir", description: "Skip matching directories", arg: "dir" },
    { name: "color", description: "Mark matches in colour", arg: "when", values: ["always", "never", "auto"] },
    { name: "quiet", short: "q", description: "No output, exit status only" },
  ],
  positional: { name: "pattern", dynamic: true },
};
