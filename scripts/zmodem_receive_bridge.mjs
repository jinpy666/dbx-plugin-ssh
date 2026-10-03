#!/usr/bin/env node
// ZMODEM receive bridge for scripts/smoke_zmodem_receive.py.
//
// Runs the frontend's actual receiver library (zmodem.js) headless and glues
// it to the Python sidecar driver over framed stdio, so the smoke exercises
// the real protocol pair — lrzsz `sz` (remote) ↔ zmodem.js (this process) —
// through the real sidecar PTY pump, byte for byte.
//
// stdin frames:  [type:u8][len:u32 BE][payload]
//   0x01 payload = terminal output chunk (stdout+stderr payloads, in
//                  sequence order) → sentry.consume
//   0x02 (empty) = no more terminal output; drain until session end, exit
//   0x03 (empty) = abort the current session (cancel-case trigger)
// stdout frames: [type:u8][len:u32 BE][payload]
//   0x81 payload = bytes to write back into the PTY (sentry/session output)
//   0x82 payload = file received: JSON {name, size, contentB64}
//   0x83 payload = progress: JSON {name, fileBytes, totalBytes}
//   0x84 payload = session end: JSON {aborted}
//   0x85 payload = detection: JSON {role}
//   0x86 payload = non-protocol passthrough bytes (to_terminal)
//
// All stdin reads are async (fs.promises on fd 0): the event loop must keep
// spinning or zmodem.js's accept() promises would never resolve.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// The smoke runs from the repo root; zmodem.js lives in frontend/node_modules
// (an existing dependency — no new runtime deps).
const zmodemPath = process.env.ZMODEM_JS_PATH || fileURLToPath(new URL("../frontend/node_modules/zmodem.js", import.meta.url));
const Zmodem = require(zmodemPath);
// Callback fs: some Node builds ship no fs.promises.read, and the async form
// is what keeps the event loop spinning for zmodem.js's accept() promises.
const fs = require("node:fs");

const readAsync = (fd, buffer, offset, length) =>
  new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, null, (error, bytesRead) => (error ? reject(error) : resolve({ bytesRead })));
  });

const TYPE_TERM_OUT = 0x01;
const TYPE_EOF = 0x02;
const TYPE_ABORT = 0x03;
const TYPE_PTY_OUT = 0x81;
const TYPE_FILE = 0x82;
const TYPE_PROGRESS = 0x83;
const TYPE_SESSION_END = 0x84;
const TYPE_DETECT = 0x85;
const TYPE_PASSTHROUGH = 0x86;

const writeFrameSync = (type, payload) => {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  let out = payload.length ? Buffer.concat([header, payload]) : header;
  let offset = 0;
  while (offset < out.length) {
    offset += fs.writeSync(1, out, offset, out.length - offset);
  }
};

const emitJson = (type, value) => writeFrameSync(type, Buffer.from(JSON.stringify(value), "utf8"));

const DEBUG = !!process.env.ZMODEM_BRIDGE_DEBUG;
const debug = (...args) => {
  if (DEBUG) console.error("[bridge]", ...args);
};

// -- receiver -----------------------------------------------------------------

let session = null;
let sessionEnded = false;
let abortedByTest = false;
let ptyOutBytes = 0;
let sentry = null;
let generation = 0;

// A throw mid- or post-session (e.g. sz's missing "OO" tail, see the consume
// catch below) poisons the sentry's parser state; the frontend answers the
// same situation by rebuilding its resident sentry — mirror that here.
function newSentry() {
  generation += 1;
  const gen = generation;
  return new Zmodem.Sentry({
    to_terminal(data) {
      debug("passthrough", data.length);
      if (data.length) writeFrameSync(TYPE_PASSTHROUGH, Buffer.from(data));
    },
    sender(data) {
      ptyOutBytes += data.length;
      debug("pty-out", data.length, "total", ptyOutBytes, Buffer.from(data).toString("hex"));
      writeFrameSync(TYPE_PTY_OUT, Buffer.from(data));
    },
    on_detect(detection) {
      debug("detect", detection.get_session_role());
      emitJson(TYPE_DETECT, { role: detection.get_session_role() });
      if (detection.get_session_role() !== "receive") {
        detection.deny();
        return;
      }
      session = detection.confirm();
      debug("session confirmed");
      session.on("offer", (offer) => {
        debug("offer", JSON.stringify(offer.get_details()));
        void acceptOffer(offer);
      });
      session.on("session_end", () => {
        if (gen !== generation) return; // stale sentry, already rebuilt
        debug("session end, aborted =", session.aborted());
        sessionEnded = true;
        emitJson(TYPE_SESSION_END, { aborted: session.aborted() || abortedByTest });
      });
      // Receive sessions must be started explicitly: start() emits the ZRINIT
      // that invites the sender's first ZFILE (confirm() alone stays silent).
      session.start().catch(() => {});
    },
    on_retract() {},
  });
}

sentry = newSentry();

async function acceptOffer(offer) {
  const details = offer.get_details();
  const name = String(details.name ?? "");
  const totalSize = Number(details.size ?? 0);
  const chunks = [];
  let fileBytes = 0;
  let lastReport = 0;
  await offer.accept({
    on_input: (payload) => {
      const chunk = Buffer.from(payload);
      chunks.push(chunk);
      fileBytes += chunk.length;
      // Throttle progress: every 64KiB keeps the pipe traffic negligible.
      if (fileBytes - lastReport >= 65536 || fileBytes === totalSize) {
        lastReport = fileBytes;
        emitJson(TYPE_PROGRESS, { name, fileBytes, totalBytes: totalSize });
      }
    },
  });
  emitJson(TYPE_FILE, { name, size: fileBytes, contentB64: Buffer.concat(chunks).toString("base64") });
}

// -- framed stdin (async; keeps the event loop alive for promise resolution) --

async function readExact(count) {
  let chunks = [];
  let have = 0;
  while (have < count) {
    const buffer = Buffer.alloc(count - have);
    const { bytesRead } = await readAsync(0, buffer, 0, count - have);
    if (!bytesRead) process.exit(0); // parent went away
    chunks.push(buffer.subarray(0, bytesRead));
    have += bytesRead;
  }
  return Buffer.concat(chunks);
}

for (;;) {
  const header = await readExact(5);
  const type = header.readUInt8(0);
  const length = header.readUInt32BE(1);
  const payload = length ? await readExact(length) : Buffer.alloc(0);
  if (type === TYPE_TERM_OUT) {
    debug("consume", payload.length);
    try {
      sentry.consume(new Uint8Array(payload).buffer);
    } catch (cause) {
      // sz exits without the final "OO" when our ZFIN response is slow (its
      // saybibi wait is 10s), and the shell prompt that follows then breaks
      // zmodem.js's post-ZFIN parse. The received files are already complete
      // at that point — surface a session end and rebuild the sentry (the
      // frontend's consumeFrameViaZmodem does the same) instead of dying.
      debug("consume threw:", String(cause));
      if (!sessionEnded) {
        sessionEnded = true;
        emitJson(TYPE_SESSION_END, { aborted: false, error: String(cause) });
      }
      session = null;
      sessionEnded = false;
      sentry = newSentry();
    }
  } else if (type === TYPE_ABORT) {
    abortedByTest = true;
    if (session && !session.has_ended()) {
      try { session.abort(); } catch { /* already ended */ }
    }
  } else if (type === TYPE_EOF) {
    // Drain until the session ends (bounded grace period — the cancel case
    // needs a moment for the remote to react to the abort sequence).
    const deadline = Date.now() + 30000;
    while (!sessionEnded && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.exit(0);
  }
}
