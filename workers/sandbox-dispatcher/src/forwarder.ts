/**
 * The sandbox-side event forwarder for the engine-push path (SYM-386).
 *
 * `/run/start` writes three files into the per-run sandbox and launches
 * the forwarder as a detached process:
 *
 *   /tmp/symphony-forwarder.mjs  — FORWARDER_SCRIPT (this module)
 *   /tmp/symphony-engine.sh      — the `pi --print --mode json …` command
 *   /tmp/symphony-ingest.json    — { url, token, instanceId, timeoutMs }
 *
 * The forwarder spawns the engine, batches its NDJSON stdout, and POSTs
 * each batch — HMAC-signed with the per-run token — to the linear-agent
 * ingest endpoint. When the engine exits it POSTs one final batch
 * carrying `exit: { code, stderr_tail }`, which is the run's terminal
 * signal regardless of whether pi emitted its own `agent_end`.
 *
 * The script is shipped as a string because Workers have no runtime
 * filesystem — the dispatcher can't read a `.mjs` off disk at request
 * time. It is authored in plain ES2020 with no template literals and no
 * `${…}` so it can live safely inside a `String.raw` literal; keep it
 * that way. The `node:` imports + global `fetch` require Node ≥ 18,
 * which the pi baseline already ships (pi is itself a Node CLI).
 */

export const FORWARDER_PATH = "/tmp/symphony-forwarder.mjs";
export const ENGINE_CMD_PATH = "/tmp/symphony-engine.sh";
export const INGEST_CONFIG_PATH = "/tmp/symphony-ingest.json";

export interface IngestConfig {
  // Full ingest URL: `<linear-agent>/internal/run-events/<runId>`.
  url: string;
  // Per-run HMAC token = HMAC-SHA256(DISPATCH_HMAC_SECRET, runId). The
  // sandbox never sees the master secret.
  token: string;
  // Workflow instance id to wake on the terminal batch.
  instanceId: string;
  // Engine timeout. The forwarder owns this timeout so it can kill the
  // child process and still POST the terminal timeout batch.
  timeoutMs: number;
}

export const FORWARDER_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const CONFIG_PATH = "/tmp/symphony-ingest.json";
const ENGINE_CMD_PATH = "/tmp/symphony-engine.sh";

const BATCH_MAX_LINES = 50;
const BATCH_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 60000;
const STDERR_TAIL_BYTES = 4000;
const POST_RETRIES = 4;

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

function sign(body) {
  return createHmac("sha256", cfg.token).update(body).digest("hex");
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function postPayload(payload) {
  const body = JSON.stringify(payload);
  const sig = sign(body);
  let lastErr = "";
  for (let attempt = 0; attempt <= POST_RETRIES; attempt++) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-signature": sig },
        body: body,
      });
      if (res.ok) return true;
      lastErr = "status " + res.status;
    } catch (e) {
      lastErr = String(e);
    }
    if (attempt < POST_RETRIES) await sleep(400 * (attempt + 1));
  }
  console.error("[forwarder] ingest POST failed: " + lastErr);
  return false;
}

async function postBatch(lines, exit) {
  const payload = { instance_id: cfg.instanceId, lines: lines };
  if (exit) payload.exit = exit;
  return postPayload(payload);
}

let pending = [];
let postChain = Promise.resolve();
let timer = null;

function flush(exit) {
  if (timer) { clearTimeout(timer); timer = null; }
  const lines = pending;
  pending = [];
  if (lines.length === 0 && !exit) return postChain;
  postChain = postChain.then(function () { return postBatch(lines, exit); });
  return postChain;
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(function () { timer = null; flush(); }, BATCH_INTERVAL_MS);
}

function onLine(line) {
  if (line.length === 0) return;
  pending.push(line);
  if (pending.length >= BATCH_MAX_LINES) flush();
  else scheduleFlush();
}

async function main() {
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : 0;
  const startedAt = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastStdoutAt = null;
  let lastStderrAt = null;
  const child = spawn("bash", [ENGINE_CMD_PATH], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let killTimer = null;
  let timeoutTimer = null;
  let heartbeatTimer = null;

  function heartbeatPayload(phase) {
    return {
      instance_id: cfg.instanceId,
      heartbeat: {
        phase: phase,
        pid: child.pid,
        elapsed_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        last_stdout_at: lastStdoutAt,
        last_stderr_at: lastStderrAt,
        pending_lines: pending.length
      }
    };
  }

  function scheduleHeartbeat() {
    heartbeatTimer = setInterval(function () {
      postPayload(heartbeatPayload(timedOut ? "timed_out" : "engine_running")).catch(function () {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  function killProcessGroup(signal) {
    try {
      process.kill(-child.pid, signal);
    } catch (_) {
      try { child.kill(signal); } catch (_) {}
    }
  }

  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(function () {
      timedOut = true;
      stderrTail = (
        stderrTail +
        "\n[forwarder] engine timed out after " +
        timeoutMs +
        "ms"
      ).slice(-STDERR_TAIL_BYTES);
      killProcessGroup("SIGTERM");
      killTimer = setTimeout(function () {
        killProcessGroup("SIGKILL");
      }, 5000);
    }, timeoutMs);
  }
  scheduleHeartbeat();

  let stdoutBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", function (chunk) {
    stdoutBytes += Buffer.byteLength(chunk);
    lastStdoutAt = Date.now();
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      onLine(stdoutBuf.slice(0, nl).replace(/\r$/, ""));
      stdoutBuf = stdoutBuf.slice(nl + 1);
    }
  });

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", function (chunk) {
    stderrBytes += Buffer.byteLength(chunk);
    lastStderrAt = Date.now();
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exitCode = await new Promise(function (resolve) {
    child.on("close", function (code, signal) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timedOut) resolve(124);
      else resolve(code == null ? (signal ? 1 : 0) : code);
    });
    child.on("error", function (e) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stderrTail = (stderrTail + "\n[forwarder] spawn error: " + e).slice(-STDERR_TAIL_BYTES);
      resolve(1);
    });
  });

  if (stdoutBuf.length > 0) onLine(stdoutBuf.replace(/\r$/, ""));

  await postPayload(heartbeatPayload("posting_terminal"));
  await flush({ code: exitCode, stderr_tail: stderrTail });
  await postChain;
}

main().then(
  function () { process.exit(0); },
  async function (e) {
    try {
      await postBatch([], { code: 1, stderr_tail: "[forwarder] fatal: " + e });
    } catch (_) {}
    process.exit(1);
  },
);
`;
