import { useState, useEffect } from "react";
import type { SessionDebug, EventSummaryItem } from "../lib/api";
import { fetchSessionDebug } from "../lib/api";
import { RerunModal } from "./RerunModal";

export function DebugPanel({
  sessionId,
  onClose,
  onRerunCreated,
}: {
  sessionId: string;
  onClose: () => void;
  onRerunCreated: () => void;
}) {
  const [debug, setDebug] = useState<SessionDebug | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRerun, setShowRerun] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSessionDebug(sessionId)
      .then((data) => {
        if (!cancelled) setDebug(data);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load debug");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={panelStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Session Debug</h3>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={() => setShowRerun(true)} style={btnStyle}>
              Rerun
            </button>
            <button onClick={onClose} style={closeBtnStyle}>
              &times;
            </button>
          </div>
        </div>

        {loading && <p style={{ color: "#6b7280" }}>Loading...</p>}
        {error && <p style={{ color: "#dc2626" }}>{error}</p>}

        {debug && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <Section title="Config Snapshot" defaultOpen>
              {debug.config_snapshot ? (
                <KeyValueTable data={debug.config_snapshot} />
              ) : (
                <EmptyState>No config snapshot available</EmptyState>
              )}
            </Section>

            <Section title="Stderr">
              {debug.stderr ? (
                <pre style={preStyle}>{debug.stderr}</pre>
              ) : (
                <EmptyState>No stderr output</EmptyState>
              )}
            </Section>

            <Section title="Dispatcher Logs">
              {debug.dispatcher_logs.length > 0 ? (
                <pre style={preStyle}>
                  {debug.dispatcher_logs
                    .map(
                      (l) =>
                        `[${l.timestamp}] ${l.level}: ${l.message}`,
                    )
                    .join("\n")}
                </pre>
              ) : (
                <EmptyState>No dispatcher logs</EmptyState>
              )}
            </Section>

            <Section title="Activity Timeline" defaultOpen>
              {debug.messages.length > 0 ? (
                <ActivityTimeline events={debug.messages} />
              ) : (
                <EmptyState>No activity events</EmptyState>
              )}
            </Section>

            {debug.error && (
              <div
                style={{
                  padding: "0.75rem",
                  backgroundColor: "#fee2e2",
                  borderRadius: "0.375rem",
                  color: "#dc2626",
                  fontSize: "0.875rem",
                }}
              >
                <strong>Error:</strong> {debug.error}
              </div>
            )}
          </div>
        )}
      </div>

      {showRerun && debug && (
        <RerunModal
          sessionId={sessionId}
          defaultPrompt={debug.prompt || ""}
          onClose={() => setShowRerun(false)}
          onRerunCreated={onRerunCreated}
        />
      )}
    </>
  );
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: "0.375rem" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          padding: "0.5rem 0.75rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "#f9fafb",
          border: "none",
          borderRadius: open ? "0.375rem 0.375rem 0 0" : "0.375rem",
          cursor: "pointer",
          fontSize: "0.875rem",
          fontWeight: 600,
        }}
      >
        {title}
        <span>{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && <div style={{ padding: "0.75rem" }}>{children}</div>}
    </div>
  );
}

function KeyValueTable({ data }: { data: Record<string, unknown> }) {
  return (
    <table style={{ width: "100%", fontSize: "0.875rem" }}>
      <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}>
            <td
              style={{
                padding: "0.25rem 0.5rem",
                fontWeight: 500,
                color: "#374151",
                whiteSpace: "nowrap",
              }}
            >
              {key}
            </td>
            <td
              style={{
                padding: "0.25rem 0.5rem",
                color: "#6b7280",
                fontFamily: "monospace",
              }}
            >
              {String(value ?? "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActivityTimeline({ events }: { events: EventSummaryItem[] }) {
  const typeColors: Record<string, string> = {
    thought: "#6366f1",
    tool_call: "#0891b2",
    tool_result: "#059669",
    assistant_msg: "#2563eb",
    error: "#dc2626",
    result: "#7c3aed",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      {events.map((ev, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: "0.5rem",
            fontSize: "0.8125rem",
            lineHeight: "1.4",
          }}
        >
          <span
            style={{
              flexShrink: 0,
              padding: "0.0625rem 0.375rem",
              borderRadius: "0.25rem",
              fontSize: "0.6875rem",
              fontWeight: 600,
              fontFamily: "monospace",
              color: "white",
              backgroundColor: typeColors[ev.type] || "#6b7280",
              alignSelf: "flex-start",
              minWidth: "4.5rem",
              textAlign: "center",
            }}
          >
            {ev.type}
          </span>
          <span
            style={{
              color: "#374151",
              wordBreak: "break-word",
              fontFamily:
                ev.type === "tool_call" || ev.type === "tool_result"
                  ? "monospace"
                  : "inherit",
            }}
          >
            {ev.body || "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: "#9ca3af", fontSize: "0.875rem", margin: 0 }}>
      {children}
    </p>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  backgroundColor: "#111827",
  color: "#e5e7eb",
  borderRadius: "0.375rem",
  fontSize: "0.75rem",
  lineHeight: "1.5",
  overflow: "auto",
  maxHeight: "20rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.2)",
  zIndex: 40,
};

const panelStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(40rem, 90vw)",
  backgroundColor: "white",
  boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
  padding: "1.5rem",
  overflowY: "auto",
  zIndex: 50,
};

const btnStyle: React.CSSProperties = {
  padding: "0.375rem 0.75rem",
  backgroundColor: "#2563eb",
  color: "white",
  border: "none",
  borderRadius: "0.375rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};

const closeBtnStyle: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  background: "none",
  border: "1px solid #d1d5db",
  borderRadius: "0.375rem",
  cursor: "pointer",
  fontSize: "1.125rem",
  lineHeight: 1,
};
