// Settings helpers shared by /api/v1/settings and /dashboard/api/settings.
//
// `validateSettingValue` is per-key validation for curated runtime
// settings (the keys the runner actually reads). Non-curated keys are
// stored as-is — the UI's Advanced tab accepts arbitrary `key=value`.
//
// `buildAgentDefaults` computes the env-derived floor surfaced to the
// dashboard as `agent_defaults`. Used to render "Default: X" hints
// alongside each curated setting.

import type { Env } from "../index";

export interface AgentDefaults {
  default_engine: string;
  default_model: string | null;
  max_turns: number;
}

export function buildAgentDefaults(env: Env): AgentDefaults {
  const rawMaxTurns = env.DEFAULT_MAX_TURNS;
  let maxTurns = 10;
  if (rawMaxTurns) {
    const n = parseInt(rawMaxTurns, 10);
    if (Number.isFinite(n) && n >= 1) maxTurns = Math.min(n, 100);
  }
  return {
    default_engine: env.DEFAULT_ENGINE || "pi",
    default_model: env.DEFAULT_MODEL || null,
    max_turns: maxTurns,
  };
}

export function validateSettingValue(key: string, value: string): string | null {
  switch (key) {
    case "agent.default_engine":
      // Keep this in sync with sandbox-dispatcher's supported engines.
      // `claude-code` is accepted by older editor surfaces but
      // normalized to `claude` by the session runner before dispatch.
      if (!["pi", "claude", "claude-code"].includes(value)) {
        return "Default engine must be `pi` or `claude`.";
      }
      return null;
    case "agent.default_model":
      if (value.trim().length === 0) {
        return "Model must be a non-empty string.";
      }
      return null;
    case "agent.max_turns": {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1 || String(n) !== value.trim()) {
        return "Max turns must be a positive integer.";
      }
      if (n > 100) {
        return "Max turns is capped at 100.";
      }
      return null;
    }
    default:
      return null;
  }
}
