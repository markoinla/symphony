import { useState, useEffect, useCallback } from "react";
import { fetchIntegrations, saveCredential, type IntegrationsStatus } from "../lib/api";

export function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchIntegrations();
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !status) {
    return <p style={{ color: "#6b7280" }}>Loading integrations...</p>;
  }

  if (error && !status) {
    return <p style={{ color: "#dc2626" }}>{error}</p>;
  }

  if (!status) return null;

  return (
    <div>
      <h2 style={{ margin: "0 0 1.5rem" }}>Integrations</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "#e5e7eb", borderRadius: "8px", overflow: "hidden" }}>
        <LinearRow connected={status.linear.connected} email={status.linear.email} />
        <GitHubRow connected={status.github.connected} repoCount={status.github.repo_count} settingsUrl={status.github_app_settings_url} />
        <BYOKeyRow provider="anthropic" label="Anthropic" configured={status.anthropic.configured} onSaved={load} />
        <BYOKeyRow provider="openai" label="OpenAI" configured={status.openai.configured} onSaved={load} />
        <BYOKeyRow provider="cf_workers_ai" label="CF Workers AI" configured={status.cf_workers_ai.configured} onSaved={load} />
      </div>

      <div style={{ marginTop: "1.5rem" }}>
        <McpStubButton />
      </div>

      {error && <p style={{ color: "#dc2626", marginTop: "1rem" }}>{error}</p>}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "1rem 1.25rem",
  background: "#fff",
  minHeight: "56px",
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: "0.95rem",
  minWidth: "120px",
};

const statusTextStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "#6b7280",
  flex: 1,
  marginLeft: "1rem",
};

const btnStyle: React.CSSProperties = {
  padding: "0.4rem 1rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

function LinearRow({ connected, email }: { connected: boolean; email: string | null }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>Linear</span>
      <span style={statusTextStyle}>
        {connected
          ? `Connected as ${email || "unknown"}`
          : "Not connected"}
      </span>
      <a href="/oauth/user/authorize" style={{ ...btnStyle, textDecoration: "none", color: "inherit" }}>
        {connected ? "Reconnect" : "Connect"}
      </a>
    </div>
  );
}

function GitHubRow({
  connected,
  repoCount,
  settingsUrl,
}: {
  connected: boolean;
  repoCount: number;
  settingsUrl: string | null;
}) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>GitHub</span>
      <span style={statusTextStyle}>
        {connected
          ? `Installed on ${repoCount} ${repoCount === 1 ? "repository" : "repositories"}`
          : "Not installed"}
      </span>
      {settingsUrl ? (
        <a href={settingsUrl} target="_blank" rel="noopener noreferrer" style={{ ...btnStyle, textDecoration: "none", color: "inherit" }}>
          Manage
        </a>
      ) : (
        <span style={{ ...btnStyle, opacity: 0.4, cursor: "default" }}>Manage</span>
      )}
    </div>
  );
}

function BYOKeyRow({
  provider,
  label,
  configured,
  onSaved,
}: {
  provider: string;
  label: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!value.trim()) return;
    try {
      setSaving(true);
      setSaveError(null);
      await saveCredential(provider, value.trim());
      setValue("");
      setEditing(false);
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setEditing(false);
      setValue("");
      setSaveError(null);
    }
  };

  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={{ ...statusTextStyle, display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {editing ? (
          <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1 }}>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Paste API key"
              autoFocus
              style={{
                padding: "0.375rem 0.5rem",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                fontSize: "0.875rem",
                flex: 1,
                maxWidth: "320px",
              }}
            />
            <button onClick={handleSave} disabled={saving || !value.trim()} style={{ ...btnStyle, background: "#5E6AD2", color: "#fff", border: "none", opacity: saving || !value.trim() ? 0.5 : 1 }}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button onClick={() => { setEditing(false); setValue(""); setSaveError(null); }} style={btnStyle}>
              Cancel
            </button>
            {saveError && <span style={{ color: "#dc2626", fontSize: "0.8rem" }}>{saveError}</span>}
          </span>
        ) : (
          <>
            {configured ? "BYO API key \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "BYO API key"}
          </>
        )}
      </span>
      {!editing && (
        <button onClick={() => setEditing(true)} style={btnStyle}>
          {configured ? "Update" : "Configure"}
        </button>
      )}
    </div>
  );
}

function McpStubButton() {
  const [showTooltip, setShowTooltip] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setShowTooltip((v) => !v)}
        onBlur={() => setShowTooltip(false)}
        style={{
          ...btnStyle,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          color: "#6b7280",
        }}
      >
        + Add MCP server
      </button>
      {showTooltip && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "0.5rem",
            padding: "0.5rem 0.75rem",
            background: "#1f2937",
            color: "#fff",
            borderRadius: "6px",
            fontSize: "0.8rem",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          Coming soon
        </div>
      )}
    </div>
  );
}
