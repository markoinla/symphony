/**
 * Engine → baseline-row alias.
 *
 * In production, every supported engine runs on the same baseline
 * snapshot (the `pi` row in D1 `engine_baselines`). That snapshot
 * ships with the `pi`, `claude`, and `codex` CLIs preinstalled and
 * logged in under `/home/symphony`. The engine adapter decides which
 * CLI to invoke; the baseline restore is shared.
 *
 * Override here when an engine genuinely needs its own snapshot — a
 * distinct base image, separate login set, or version pin. Snapshot
 * authoring still goes through `mix symphony.baseline.save --engine
 * <target>`; only the run-time lookup key is aliased.
 *
 * This is deliberately a hard remap (not a fallback). If the resolved
 * row is missing, dispatch fails fast with `missing_baseline` rather
 * than silently picking whatever else is in the table.
 */
const BASELINE_ALIASES: Record<string, string> = {
  pi: "pi",
  claude: "pi",
};

export function resolveBaselineEngine(engine: string): string {
  return BASELINE_ALIASES[engine] ?? engine;
}
