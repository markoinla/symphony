/**
 * HMAC-signed client for the sandbox-dispatcher Worker's `/run` route.
 *
 * Wire format must match `workers/sandbox-dispatcher/src/hmac.ts` and the
 * Elixir `SymphonyElixir.Cloudflare.DispatcherClient` (already in
 * production):
 *
 *   - Algorithm: HMAC-SHA256
 *   - Key:       `DISPATCH_HMAC_SECRET` (shared secret)
 *   - Body:      raw request bytes (empty string for GET; we POST JSON)
 *   - Header:    `X-Symphony-Signature` (lowercase hex)
 *
 * The pinned test vector is in
 * `test/symphony_elixir/cloudflare/dispatcher_client_test.exs`:
 *   secret = "test-secret-do-not-use-in-prod"
 *   body   = '{"scope":"alice"}'
 *   sig    = "1628b1de2425d3d72af853cd72a18a7cdadda178157642d42411d70760b15b46"
 *
 * `dispatcher.test.ts` re-checks that vector to keep all three signers
 * (Elixir, dispatcher worker, this client) wire-compatible.
 */

export interface McpServerCredential {
  name: string;
  url: string;
  token: string;
}

export interface RunCredentials {
  cloudflare_account_id?: string;
  cloudflare_api_token?: string;
  anthropic_api_key?: string;
  openai_api_key?: string;
  github_token?: string;
  /**
   * Linear OAuth bearer (user or app-scoped) used by the sandbox's
   * `linear` skill (baked into the engine baseline) to call Linear's
   * GraphQL API. The dispatcher exposes this as `LINEAR_API_TOKEN` in
   * the sandbox env; the skill reads it as its bearer. We used to wire
   * Linear's hosted MCP via `mcp_servers` instead; the skill path is
   * engine-agnostic and avoids the MCP cold-start + hosted-MCP
   * availability dependency. See `src/lib/prompts/linear-graphql.ts`
   * for the skill pointer appended to every prompt.
   */
  linear_token?: string;
  mcp_servers?: McpServerCredential[];
}

export interface RunArgs {
  scope: string;
  issueId: string;
  repoUrl: string;
  prompt: string;
  engine: "pi";
  model?: string | null;
  timeoutMs?: number;
  githubToken?: string | null;
  credentials?: RunCredentials | null;
  /**
   * Optional branch to check out before the engine runs. The dispatcher
   * fetches the branch from origin if it exists, otherwise creates it
   * from the repo's default branch HEAD. When omitted, the engine runs
   * on the default branch (current behavior).
   */
  branch?: string | null;
}

export interface RunResult {
  engine: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/**
 * Engine-agnostic event envelope received from `/run` when the caller
 * asks for `Accept: text/event-stream`. The shape is mirrored in
 * `workers/sandbox-dispatcher/src/engines/types.ts` — keep them in
 * sync. A change here without a matching change there (or vice versa)
 * silently drops events on the floor.
 */
export type NormalizedEvent =
  | { type: "thought"; turn?: number; text: string }
  | {
      type: "tool_call";
      turn?: number;
      tool: string;
      args?: unknown;
      tool_id?: string;
    }
  | {
      type: "tool_result";
      turn?: number;
      tool_id?: string;
      ok: boolean;
      result?: string;
    }
  | { type: "assistant_msg"; turn?: number; text: string }
  | {
      type: "turn_end";
      turn: number;
      reason: "completed" | "needs_continuation" | "error";
    }
  | { type: "error"; message: string }
  | {
      type: "result";
      exit_code: number;
      duration_ms: number;
      branch: string | null;
      pr_url: string | null;
    };

export interface DispatcherErrorBody {
  error: string;
  [key: string]: unknown;
}

export class DispatcherError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: DispatcherErrorBody | string,
  ) {
    super(`dispatcher_error: ${status} ${typeof body === "string" ? body : body.error}`);
    this.name = "DispatcherError";
  }
}

export class DispatcherClient {
  // Stored as a plain field, not `private readonly` on a class method
  // call site: invoking `this.fetchImpl(...)` binds `this` to the class
  // instance, but Workers' global `fetch` requires `this` to be either
  // `undefined`/the global, and throws "Illegal invocation" otherwise.
  // We hold the fn here and dereference into a local before calling so
  // the call site is a bareword function invocation.
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async run(args: RunArgs): Promise<RunResult> {
    const body = JSON.stringify(serializeRunArgs(args));

    const sig = await computeSignature(this.secret, body);

    const fetchFn = this.fetchImpl;
    const res = await fetchFn(`${stripTrailingSlash(this.url)}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Signature": sig,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      let parsed: DispatcherErrorBody | string;
      try {
        parsed = JSON.parse(text) as DispatcherErrorBody;
      } catch {
        parsed = text;
      }
      throw new DispatcherError(res.status, parsed);
    }

    return (await res.json()) as RunResult;
  }

  /**
   * Stream `/run` with `Accept: text/event-stream`. Yields normalized
   * events as they arrive. Terminates after a `result` event. The
   * server always emits exactly one `result` even on internal failure,
   * so the consumer loop reliably hits a terminal frame.
   *
   * Errors raised from this method (non-2xx response, parse failures)
   * indicate the connection itself failed before any normalized event
   * was emitted. In-band failures during the run arrive as `error`
   * events followed by a non-zero `result` and are NOT thrown.
   */
  /**
   * Tear down the per-issue sandbox without dispatching a new run.
   * Hits the dispatcher's `/run/stop` endpoint which calls
   * `safeDestroy` on the Sandbox DO. Idempotent — destroying a
   * sandbox that doesn't exist returns 200 ok.
   *
   * Called from SessionRunner's outer try/finally so an aborted /
   * errored / timed-out workflow run can't leave a zombie sandbox
   * burning CPU. Without this, a hung pi process keeps the dispatcher
   * IIFE's `for await` blocked, the IIFE never reaches its `finally`,
   * and the sandbox lives until the in-container 30-min exec timeout
   * elapses.
   */
  async stop(issueId: string): Promise<void> {
    const body = JSON.stringify({ issue_id: issueId });
    const sig = await computeSignature(this.secret, body);
    const fetchFn = this.fetchImpl;
    const res = await fetchFn(`${stripTrailingSlash(this.url)}/run/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Symphony-Signature": sig,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: DispatcherErrorBody | string;
      try {
        parsed = JSON.parse(text) as DispatcherErrorBody;
      } catch {
        parsed = text;
      }
      throw new DispatcherError(res.status, parsed);
    }
  }

  async *runStream(args: RunArgs): AsyncIterable<NormalizedEvent> {
    const body = JSON.stringify(serializeRunArgs(args));

    const sig = await computeSignature(this.secret, body);

    const fetchFn = this.fetchImpl;
    const res = await fetchFn(`${stripTrailingSlash(this.url)}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Symphony-Signature": sig,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      let parsed: DispatcherErrorBody | string;
      try {
        parsed = JSON.parse(text) as DispatcherErrorBody;
      } catch {
        parsed = text;
      }
      throw new DispatcherError(res.status, parsed);
    }
    if (!res.body) {
      throw new DispatcherError(0, "empty_stream_body");
    }

    for await (const event of parseSseEvents(res.body)) {
      yield event;
      if (event.type === "result") return;
    }
  }
}

/**
 * Minimal SSE parser. Reads `data: <json>\n\n` frames from a
 * ReadableStream of bytes, parses each frame as a NormalizedEvent, and
 * yields it. Non-data lines (`event:`, `id:`, `:` comments) are
 * ignored — we don't use them.
 *
 * Inlined rather than depending on `@cloudflare/sandbox`'s parser
 * because (a) the linear-agent worker doesn't pull in that package and
 * (b) keeping the wire-format reader local makes the cross-worker
 * boundary easier to test.
 */
async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<NormalizedEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    // Flush any trailing single-line frame (no double-newline).
    if (buffer.length > 0) {
      const parsed = parseSseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function parseSseFrame(frame: string): NormalizedEvent | null {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (json.length === 0) continue;
    try {
      return JSON.parse(json) as NormalizedEvent;
    } catch {
      return null;
    }
  }
  return null;
}

export async function computeSignature(
  secret: string,
  body: string | Uint8Array,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? enc.encode(body) : body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
  let out = "";
  for (const byte of sig) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Map a Linear issue identifier (or session-id fallback) to the
 * dispatcher branch name we use for continuity across multiple runs on
 * the same issue. Format: `symphony/<lowercased-sanitized-identifier>`.
 *
 * - `SYM-123` → `symphony/sym-123`
 * - UUIDs → `symphony/<uuid>` (still groups runs that share that uuid)
 *
 * Sanitization: lowercase, replace anything outside `[a-z0-9._-]` with
 * `-`, strip non-alphanumeric edges so the result satisfies the
 * dispatcher's `parseBranch` regex. Returns null if nothing usable
 * remains (caller should then omit the branch field).
 */
export function deriveBranchFromIssueIdentifier(
  identifier: string,
): string | null {
  const sanitized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (sanitized.length === 0) return null;
  return `symphony/${sanitized}`;
}

function serializeRunArgs(
  args: RunArgs,
): Record<string, unknown> {
  return {
    scope: args.scope,
    issue_id: args.issueId,
    repo_url: args.repoUrl,
    prompt: args.prompt,
    engine: args.engine,
    ...(args.model ? { model: args.model } : {}),
    ...(args.timeoutMs ? { timeout_ms: args.timeoutMs } : {}),
    ...(args.githubToken ? { github_token: args.githubToken } : {}),
    ...(args.credentials ? { credentials: args.credentials } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
  };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
