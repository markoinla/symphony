/**
 * Test-only stub for the `cloudflare:workers` runtime module.
 *
 * The real module is a virtual ESM provided by the Workers runtime
 * (wrangler / Cloudflare's edge), so it can't be resolved in plain
 * vitest under Node. `vitest.config.ts` aliases `cloudflare:workers` to
 * this file so tests that touch SessionRunner can import without
 * pulling in `@cloudflare/vitest-pool-workers`.
 *
 * The stub mirrors only the surface SessionRunner consumes:
 *   - `WorkflowEntrypoint` — base class providing `env`, `ctx`.
 *   - `WorkflowStep`, `WorkflowEvent` — type-only.
 *
 * The real runtime invokes `run(event, step)` itself; tests construct
 * a runner via `Object.create(SessionRunner.prototype)` and pass a
 * hand-rolled `step` stub directly, so the base class's behavior is
 * never exercised here.
 */

export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected env!: Env;
  protected ctx: unknown = {};

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export interface WorkflowStep {
  do<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  do<T>(
    name: string,
    options: unknown,
    fn: () => T | Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

export interface WorkflowEvent<T> {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
}
