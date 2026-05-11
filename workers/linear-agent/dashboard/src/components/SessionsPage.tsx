import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionRow, SessionFilters } from "../lib/api";
import { fetchSessions } from "../lib/api";
import { connectSessionsSSE } from "../lib/streams";
import { DebugPanel } from "./DebugPanel";

function useFiltersFromURL(): SessionFilters {
  const params = new URLSearchParams(window.location.search);
  return {
    team: params.get("team") || undefined,
    repo: params.get("repo") || undefined,
    status: params.get("status") || undefined,
    triggered_by: params.get("triggered_by") || undefined,
  };
}

function syncFiltersToURL(filters: SessionFilters) {
  const params = new URLSearchParams();
  if (filters.team) params.set("team", filters.team);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.status) params.set("status", filters.status);
  if (filters.triggered_by) params.set("triggered_by", filters.triggered_by);
  const qs = params.toString();
  const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  window.history.replaceState(null, "", newUrl);
}

const STATUS_OPTIONS = ["", "running", "completed", "error"];

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [filters, setFilters] = useState<SessionFilters>(useFiltersFromURL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSessions(filters);
      setSessions(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const disconnect = connectSessionsSSE((event) => {
      if (event.type === "session_update") {
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === event.session.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = event.session;
            return updated;
          }
          return [event.session, ...prev];
        });
      }
    });
    return disconnect;
  }, []);

  const updateFilter = (key: keyof SessionFilters, value: string) => {
    const next = { ...filters, [key]: value || undefined };
    setFilters(next);
    syncFiltersToURL(next);
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 1rem" }}>Sessions</h2>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <FilterInput
          label="Team"
          value={filters.team || ""}
          onChange={(v) => updateFilter("team", v)}
        />
        <FilterInput
          label="Repo"
          value={filters.repo || ""}
          onChange={(v) => updateFilter("repo", v)}
        />
        <FilterSelect
          label="Status"
          value={filters.status || ""}
          options={STATUS_OPTIONS}
          onChange={(v) => updateFilter("status", v)}
        />
        <FilterInput
          label="Triggered by"
          value={filters.triggered_by || ""}
          onChange={(v) => updateFilter("triggered_by", v)}
        />
      </div>

      {error && (
        <div style={{ color: "#dc2626", marginBottom: "1rem" }}>{error}</div>
      )}

      {loading && sessions.length === 0 ? (
        <p style={{ color: "#6b7280" }}>Loading sessions...</p>
      ) : sessions.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No sessions found.</p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.875rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
              <th style={thStyle}>Issue</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Team</th>
              <th style={thStyle}>Repo</th>
              <th style={thStyle}>Triggered</th>
              <th style={thStyle}>Started</th>
              <th style={thStyle}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                style={{
                  borderBottom: "1px solid #e5e7eb",
                  cursor: "pointer",
                  backgroundColor:
                    selectedId === s.id ? "#eff6ff" : "transparent",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor =
                    selectedId === s.id ? "#eff6ff" : "#f9fafb")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor =
                    selectedId === s.id ? "#eff6ff" : "transparent")
                }
              >
                <td style={tdStyle}>
                  {s.linear_issue_title || s.linear_issue_id || s.id.slice(0, 8)}
                </td>
                <td style={tdStyle}>
                  <StatusBadge status={s.status} />
                </td>
                <td style={tdStyle}>{s.team || "—"}</td>
                <td style={tdStyle}>
                  {s.repo ? repoShortName(s.repo) : "—"}
                </td>
                <td style={tdStyle}>{s.triggered_by || "—"}</td>
                <td style={tdStyle}>{formatTime(s.started_at)}</td>
                <td style={tdStyle}>
                  {s.completed_at ? formatTime(s.completed_at) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedId && (
        <DebugPanel
          sessionId={selectedId}
          onClose={() => setSelectedId(null)}
          onRerunCreated={() => loadSessions()}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    running: { bg: "#dbeafe", text: "#1d4ed8" },
    completed: { bg: "#dcfce7", text: "#15803d" },
    error: { bg: "#fee2e2", text: "#dc2626" },
  };
  const c = colors[status] || { bg: "#f3f4f6", text: "#374151" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.125rem 0.5rem",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        fontWeight: 500,
        backgroundColor: c.bg,
        color: c.text,
      }}
    >
      {status === "running" && <Spinner />}
      {status}
    </span>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "0.625rem",
        height: "0.625rem",
        border: "1.5px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    />
  );
}

function FilterInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Filter by ${label.toLowerCase()}`}
        style={inputStyle}
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "All"}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function repoShortName(url: string): string {
  const match = url.match(/github\.com\/([^/]+\/[^/.]+)/);
  return match ? match[1] : url;
}

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "200px",
};

const inputStyle: React.CSSProperties = {
  padding: "0.375rem 0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  minWidth: "120px",
};
