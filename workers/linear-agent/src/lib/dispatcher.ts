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

export interface RunArgs {
  scope: string;
  issueId: string;
  repoUrl: string;
  prompt: string;
  engine: "pi";
  model?: string | null;
  timeoutMs?: number;
}

export interface RunResult {
  engine: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

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
  constructor(
    private readonly url: string,
    private readonly secret: string,
    // Allow tests to inject a fetch implementation. Prod uses globalThis.fetch.
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(args: RunArgs): Promise<RunResult> {
    const body = JSON.stringify({
      scope: args.scope,
      issue_id: args.issueId,
      repo_url: args.repoUrl,
      prompt: args.prompt,
      engine: args.engine,
      ...(args.model ? { model: args.model } : {}),
      ...(args.timeoutMs ? { timeout_ms: args.timeoutMs } : {}),
    });

    const sig = await computeSignature(this.secret, body);

    const res = await this.fetchImpl(`${stripTrailingSlash(this.url)}/run`, {
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

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
