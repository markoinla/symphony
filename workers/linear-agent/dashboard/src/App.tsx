import { useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api";
import { IntegrationsPage } from "./pages/Integrations";
import { ProjectsPage } from "./pages/Projects";

type Tab = "integrations" | "projects";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<{ status?: number; message: string } | null>(null);
  const [tab, setTab] = useState<Tab>("integrations");

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch((e) => {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : undefined;
        setMeError({ status, message: e?.message ?? "unknown_error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (meError?.status === 401) {
    return (
      <div className="page-shell">
        <div className="card">
          <h2>Sign in</h2>
          <p>You need to sign into Linear to use the dashboard.</p>
          <a className="button button-primary" href="/oauth/user/authorize">
            Sign in with Linear
          </a>
        </div>
      </div>
    );
  }

  if (meError) {
    return (
      <div className="page-shell">
        <div className="error-card">
          <strong>Couldn't load /api/v1/me</strong>
          <p>{meError.message}</p>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="page-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Symphony · Linear Agent</h1>
          <span className="muted">{me.organization.name ?? me.organization.id}</span>
        </div>
        <div className="topbar-right">
          <span>{me.user.name ?? me.user.email ?? me.user.id}</span>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={tab === "integrations" ? "tab tab-active" : "tab"}
          onClick={() => setTab("integrations")}
        >
          Integrations
        </button>
        <button
          className={tab === "projects" ? "tab tab-active" : "tab"}
          onClick={() => setTab("projects")}
        >
          Projects
        </button>
      </nav>

      <main className="page-main">
        {tab === "integrations" ? <IntegrationsPage me={me} /> : <ProjectsPage />}
      </main>
    </div>
  );
}
