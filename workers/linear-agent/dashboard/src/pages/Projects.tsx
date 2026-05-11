import { useEffect, useState } from "react";
import { api, type Project } from "../api";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Project> | null>(null);

  function refresh() {
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e?.message ?? "unknown_error"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(input: Partial<Project>) {
    if (!input.team_id || !input.repo_url) return;
    await api.saveProject({
      team_id: input.team_id,
      repo_url: input.repo_url,
      default_branch: input.default_branch ?? undefined,
      engine: input.engine ?? undefined,
      model: input.model ?? null,
      max_turns: input.max_turns ?? undefined,
      scope_override: input.scope_override ?? null,
      system_prompt_override: input.system_prompt_override ?? null,
    });
    setEditing(null);
    refresh();
  }

  async function remove(teamId: string) {
    if (!confirm(`Delete project for team ${teamId}?`)) return;
    await api.deleteProject(teamId);
    refresh();
  }

  if (error) return <div className="error-card">{error}</div>;
  if (!projects) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h2>Projects</h2>
          <button
            className="button button-primary"
            onClick={() => setEditing({ engine: "pi", max_turns: 10, default_branch: "main" })}
          >
            + Add project
          </button>
        </div>
        <p className="muted">
          Per-team config: which Linear team maps to which GitHub repo, plus
          optional engine/model overrides.
        </p>

        {projects.length === 0 ? (
          <p className="muted">No projects yet. Add one to start running.</p>
        ) : (
          <table className="project-table">
            <thead>
              <tr>
                <th>Linear team</th>
                <th>Repo</th>
                <th>Branch</th>
                <th>Engine / model</th>
                <th>Max turns</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.team_id}>
                  <td>
                    <code>{p.team_id}</code>
                  </td>
                  <td>
                    <a href={p.repo_url} target="_blank" rel="noopener noreferrer">
                      {p.repo_url}
                    </a>
                  </td>
                  <td>{p.default_branch}</td>
                  <td>
                    {p.engine}
                    {p.model ? ` · ${p.model}` : ""}
                  </td>
                  <td>{p.max_turns}</td>
                  <td className="row-actions">
                    <button onClick={() => setEditing(p)}>Edit</button>
                    <button className="button-danger" onClick={() => remove(p.team_id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <ProjectForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function ProjectForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: Partial<Project>;
  onCancel: () => void;
  onSave: (p: Partial<Project>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Partial<Project>>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !initial.team_id;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function field<K extends keyof Project>(k: K) {
    return draft[k] ?? "";
  }
  function update<K extends keyof Project>(k: K, v: Project[K] | null) {
    setDraft({ ...draft, [k]: v });
  }

  return (
    <section className="card">
      <h2>{isNew ? "Add project" : `Edit project ${initial.team_id}`}</h2>
      <form className="form-grid" onSubmit={submit}>
        <label>
          Linear team id
          <input
            value={field("team_id") as string}
            onChange={(e) => update("team_id", e.target.value)}
            disabled={!isNew}
            required
          />
        </label>
        <label>
          Repo URL
          <input
            value={field("repo_url") as string}
            onChange={(e) => update("repo_url", e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            required
          />
        </label>
        <label>
          Default branch
          <input
            value={field("default_branch") as string}
            onChange={(e) => update("default_branch", e.target.value)}
          />
        </label>
        <label>
          Engine
          <select
            value={(field("engine") as string) || "pi"}
            onChange={(e) => update("engine", e.target.value)}
          >
            <option value="pi">pi</option>
            <option value="claude">claude (future)</option>
            <option value="codex">codex (future)</option>
          </select>
        </label>
        <label>
          Model
          <input
            value={(field("model") as string) ?? ""}
            onChange={(e) => update("model", e.target.value || null)}
            placeholder="e.g. cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6"
          />
        </label>
        <label>
          Max turns
          <input
            type="number"
            min={1}
            max={100}
            value={(draft.max_turns ?? 10) as number}
            onChange={(e) => update("max_turns", parseInt(e.target.value, 10))}
          />
        </label>
        <label>
          Scope override
          <input
            value={(field("scope_override") as string) ?? ""}
            onChange={(e) => update("scope_override", e.target.value || null)}
            placeholder="(optional)"
          />
        </label>
        <label className="form-full">
          System prompt override
          <textarea
            value={(field("system_prompt_override") as string) ?? ""}
            onChange={(e) => update("system_prompt_override", e.target.value || null)}
            rows={4}
            placeholder="(optional) override the system prompt for this team only"
          />
        </label>
        <div className="form-actions">
          {err && <span className="error-inline">{err}</span>}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={busy}>
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
