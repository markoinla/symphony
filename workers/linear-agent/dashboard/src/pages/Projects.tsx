import { useState, useEffect, useCallback } from "react";
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  ApiError,
  type Project,
  type ProjectInput,
} from "../lib/api";

const EMPTY_FORM: ProjectInput = {
  linear_team_id: "",
  linear_team_name: "",
  repo_url: "",
  default_branch: "main",
  engine: "pi",
  model: null,
  scope: null,
  system_prompt_override: null,
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [form, setForm] = useState<ProjectInput>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      setError(null);
      const data = await listProjects();
      setProjects(data);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.body.error : "Failed to load projects",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  function openCreate() {
    setEditingProject(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setModalOpen(true);
  }

  function openEdit(project: Project) {
    setEditingProject(project);
    setForm({
      linear_team_id: project.linear_team_id,
      linear_team_name: project.linear_team_name,
      repo_url: project.repo_url,
      default_branch: project.default_branch,
      engine: project.engine,
      model: project.model,
      scope: project.scope,
      system_prompt_override: project.system_prompt_override,
    });
    setFieldErrors({});
    setModalOpen(true);
  }

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!form.linear_team_id.trim()) {
      errors.linear_team_id = "Team ID is required";
    }
    if (!form.repo_url.trim()) {
      errors.repo_url = "Repo URL is required";
    } else if (!/^https?:\/\/.+/.test(form.repo_url)) {
      errors.repo_url = "Must be a valid URL (https://...)";
    }
    if (!form.default_branch.trim()) {
      errors.default_branch = "Branch is required";
    }
    return errors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    setFieldErrors({});

    try {
      if (editingProject) {
        await updateProject(editingProject.id, form);
      } else {
        await createProject(form);
      }
      setModalOpen(false);
      await loadProjects();
    } catch (e) {
      if (e instanceof ApiError && e.body.fields) {
        setFieldErrors(e.body.fields);
      } else if (e instanceof ApiError) {
        setFieldErrors({ _form: e.body.error });
      } else {
        setFieldErrors({ _form: "An unexpected error occurred" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteProject(id);
      setDeletingId(null);
      await loadProjects();
    } catch (e) {
      setError(
        e instanceof ApiError ? e.body.error : "Failed to delete project",
      );
      setDeletingId(null);
    }
  }

  function setField(key: keyof ProjectInput, value: string) {
    setForm((prev) => ({ ...prev, [key]: value || null }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      delete next._form;
      return next;
    });
  }

  function setRequiredField(key: keyof ProjectInput, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      delete next._form;
      return next;
    });
  }

  if (loading) {
    return <p>Loading projects...</p>;
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Projects</h2>
        <button onClick={openCreate} style={buttonStyle}>
          Add project
        </button>
      </div>

      {error && (
        <div style={errorBannerStyle}>
          {error}
          <button
            onClick={() => setError(null)}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <p style={{ color: "#666", fontStyle: "italic" }}>
          No projects yet — add a project to get started.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Team</th>
                <th style={thStyle}>Repo URL</th>
                <th style={thStyle}>Branch</th>
                <th style={thStyle}>Engine</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Scope</th>
                <th style={{ ...thStyle, width: "120px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td style={tdStyle}>
                    {project.linear_team_name || project.linear_team_id}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{ fontSize: "0.85em", wordBreak: "break-all" }}
                    >
                      {project.repo_url}
                    </span>
                  </td>
                  <td style={tdStyle}>{project.default_branch}</td>
                  <td style={tdStyle}>{project.engine}</td>
                  <td style={tdStyle}>{project.model || "—"}</td>
                  <td style={tdStyle}>{project.scope || "—"}</td>
                  <td style={tdStyle}>
                    {deletingId === project.id ? (
                      <span>
                        Delete?{" "}
                        <button
                          onClick={() => handleDelete(project.id)}
                          style={linkButtonStyle}
                        >
                          Yes
                        </button>
                        {" / "}
                        <button
                          onClick={() => setDeletingId(null)}
                          style={linkButtonStyle}
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => openEdit(project)}
                          style={linkButtonStyle}
                        >
                          Edit
                        </button>{" "}
                        <button
                          onClick={() => setDeletingId(project.id)}
                          style={{ ...linkButtonStyle, color: "#c00" }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div style={overlayStyle} onClick={() => setModalOpen(false)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 1rem" }}>
              {editingProject ? "Edit project" : "Add project"}
            </h3>

            {fieldErrors._form && (
              <div style={errorBannerStyle}>{fieldErrors._form}</div>
            )}

            <form onSubmit={handleSubmit}>
              <FormField
                label="Linear Team ID *"
                value={form.linear_team_id}
                error={fieldErrors.linear_team_id}
                onChange={(v) => setRequiredField("linear_team_id", v)}
              />
              <FormField
                label="Team Name"
                value={form.linear_team_name}
                error={fieldErrors.linear_team_name}
                onChange={(v) => setRequiredField("linear_team_name", v)}
              />
              <FormField
                label="Repo URL *"
                value={form.repo_url}
                error={fieldErrors.repo_url}
                onChange={(v) => setRequiredField("repo_url", v)}
                placeholder="https://github.com/org/repo"
              />
              <FormField
                label="Default Branch *"
                value={form.default_branch}
                error={fieldErrors.default_branch}
                onChange={(v) => setRequiredField("default_branch", v)}
                placeholder="main"
              />
              <FormField
                label="Engine"
                value={form.engine}
                error={fieldErrors.engine}
                onChange={(v) => setRequiredField("engine", v)}
                placeholder="pi"
              />
              <FormField
                label="Model"
                value={form.model ?? ""}
                error={fieldErrors.model}
                onChange={(v) => setField("model", v)}
              />
              <FormField
                label="Scope"
                value={form.scope ?? ""}
                error={fieldErrors.scope}
                onChange={(v) => setField("scope", v)}
              />

              <div style={fieldWrapperStyle}>
                <label style={labelStyle}>System Prompt Override</label>
                <textarea
                  value={form.system_prompt_override ?? ""}
                  onChange={(e) =>
                    setField("system_prompt_override", e.target.value)
                  }
                  rows={4}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    fontFamily: "monospace",
                    fontSize: "0.85em",
                  }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  justifyContent: "flex-end",
                  marginTop: "1rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  style={cancelButtonStyle}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} style={buttonStyle}>
                  {saving
                    ? "Saving..."
                    : editingProject
                      ? "Save changes"
                      : "Create project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function FormField({
  label,
  value,
  error,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={fieldWrapperStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          ...inputStyle,
          borderColor: error ? "#c00" : "#ccc",
        }}
      />
      {error && <span style={fieldErrorStyle}>{error}</span>}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.4rem 0.8rem",
  background: "#0066cc",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "0.9rem",
};

const cancelButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#666",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#0066cc",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  fontSize: "inherit",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid #ddd",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: "8px",
  padding: "1.5rem",
  width: "100%",
  maxWidth: "520px",
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: "0 4px 24px rgba(0,0,0,0.2)",
};

const fieldWrapperStyle: React.CSSProperties = {
  marginBottom: "0.75rem",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "0.25rem",
  fontSize: "0.85rem",
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem",
  border: "1px solid #ccc",
  borderRadius: "4px",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

const fieldErrorStyle: React.CSSProperties = {
  color: "#c00",
  fontSize: "0.8rem",
  marginTop: "0.15rem",
  display: "block",
};

const errorBannerStyle: React.CSSProperties = {
  background: "#fee",
  border: "1px solid #c00",
  borderRadius: "4px",
  padding: "0.5rem 0.75rem",
  color: "#c00",
  marginBottom: "0.75rem",
  display: "flex",
  alignItems: "center",
};
