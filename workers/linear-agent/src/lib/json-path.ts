// Tiny JSONPath subset used by Generic webhook sources.
//
// Supports the stable, common form used by Symphony configs:
//   $.event.id
//   $['event']['id']
//   $.items[0].id
// Wildcards, recursive descent, filters, and slices are intentionally
// unsupported; malformed paths return null instead of throwing.

export function readJsonPath(value: unknown, path: string | null | undefined): unknown | null {
  if (!path || !path.startsWith("$")) return null;
  const tokens = tokenize(path);
  if (!tokens) return null;

  let current: unknown = value;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) return null;
      current = current[token];
      continue;
    }

    if (current == null || typeof current !== "object" || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, token)) return null;
    current = record[token];
  }
  return current ?? null;
}

function tokenize(path: string): Array<string | number> | null {
  const tokens: Array<string | number> = [];
  let i = 1;

  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_-]/.test(path[i] ?? "")) i += 1;
      if (i === start) return null;
      tokens.push(path.slice(start, i));
      continue;
    }

    if (ch === "[") {
      const end = path.indexOf("]", i + 1);
      if (end < 0) return null;
      const raw = path.slice(i + 1, end).trim();
      if (/^\d+$/.test(raw)) {
        tokens.push(Number.parseInt(raw, 10));
      } else {
        const m = raw.match(/^['"]([^'"]+)['"]$/);
        if (!m || m[1] === undefined) return null;
        tokens.push(m[1]);
      }
      i = end + 1;
      continue;
    }

    return null;
  }

  return tokens;
}
