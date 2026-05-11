import { useEffect, useState } from "react";
import { api, type IntegrationsState, type Me } from "../api";

interface Props {
  me: Me;
}

const BYO_FIELDS: Array<{ kind: string; label: string }> = [
  { kind: "anthropic_api_key", label: "Anthropic API key" },
  { kind: "openai_api_key", label: "OpenAI API key" },
  { kind: "cloudflare_account_id", label: "Cloudflare account id" },
  { kind: "cloudflare_api_token", label: "Cloudflare API token" },
];

export function IntegrationsPage({ me }: Props) {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api
      .integrations()
      .then(setState)
      .catch((e) => setError(e?.message ?? "unknown_error"));
  }

  useEffect(() => {
    refresh();
  }, []);

  if (error) return <div className="error-card">{error}</div>;
  if (!state) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <section className="card">
        <h2>Linear</h2>
        <p>
          Connected as <strong>{me.user.email ?? me.user.name ?? me.user.id}</strong>{" "}
          for <strong>{me.organization.name ?? me.organization.id}</strong>.
        </p>
        <a className="button" href="/oauth/user/authorize">
          Reconnect
        </a>
      </section>

      <section className="card">
        <h2>GitHub</h2>
        {state.github.installed ? (
          <>
            <p>
              Symphony GitHub App installed (id <code>{state.github.installation_id}</code>).
            </p>
            <a className="button" href="/github/install/start">
              Manage / Re-install
            </a>
          </>
        ) : (
          <>
            <p>
              Install the Symphony GitHub App on your repos so the agent can
              push branches and open PRs.
            </p>
            <a className="button button-primary" href="/github/install/start">
              Install GitHub App
            </a>
          </>
        )}
      </section>

      <section className="card">
        <h2>BYO API keys</h2>
        <p className="muted">
          Stored encrypted (per-org DEK wrapped with master KEK). Used as
          env vars on every <code>/run</code>.
        </p>
        <table className="key-table">
          <tbody>
            {BYO_FIELDS.map(({ kind, label }) => (
              <ByoKeyRow
                key={kind}
                kind={kind}
                label={label}
                configured={state.byo[kind]?.configured ?? false}
                onSaved={refresh}
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ByoKeyRow({
  kind,
  label,
  configured,
  onSaved,
}: {
  kind: string;
  label: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!value) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setIntegration(kind, value);
      setValue("");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteIntegration(kind);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <label htmlFor={`byo-${kind}`}>{label}</label>
        <div className="status">
          {configured ? (
            <span className="dot dot-ok" />
          ) : (
            <span className="dot dot-off" />
          )}
          <span className="muted">{configured ? "Configured" : "Not set"}</span>
        </div>
      </td>
      <td>
        <input
          id={`byo-${kind}`}
          type="password"
          autoComplete="off"
          placeholder={configured ? "Update value…" : "Paste value…"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
      </td>
      <td className="row-actions">
        <button onClick={save} disabled={!value || busy}>
          {configured ? "Update" : "Save"}
        </button>
        {configured && (
          <button className="button-danger" onClick={clear} disabled={busy}>
            Clear
          </button>
        )}
        {err && <span className="error-inline">{err}</span>}
      </td>
    </tr>
  );
}
