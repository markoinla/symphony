import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  Link,
} from "@tanstack/react-router";
import { AuthContext, useAuth, useAuthProvider } from "./use-auth";

const rootRoute = createRootRoute({
  component: RootShell,
});

function RootShell() {
  const auth = useAuthProvider();
  return (
    <AuthContext.Provider value={auth}>
      <Outlet />
    </AuthContext.Provider>
  );
}

// --- Login page (unauthenticated) ---

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard/login",
  component: LoginPage,
});

function LoginPage() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "#f5f5f5",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "8px",
          padding: "2.5rem",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          textAlign: "center",
          maxWidth: "360px",
          width: "100%",
        }}
      >
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
          Linear Agent
        </h1>
        <p style={{ color: "#666", margin: "0 0 1.5rem", fontSize: "0.9rem" }}>
          Sign in to access the dashboard
        </p>
        <a
          href="/oauth/user/authorize"
          style={{
            display: "inline-block",
            padding: "0.7rem 1.5rem",
            background: "#5E6AD2",
            color: "#fff",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "0.95rem",
          }}
        >
          Sign in with Linear
        </a>
      </div>
    </div>
  );
}

// --- Authenticated layout ---

const dashboardLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "dashboard-layout",
  component: DashboardLayout,
});

function DashboardLayout() {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", textAlign: "center" }}>
        Loading...
      </div>
    );
  }

  if (!user) {
    window.location.href = "/dashboard/login";
    return null;
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Linear Agent</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "0.85rem", color: "#666" }}>
            {user.name || user.email}
          </span>
          <button
            onClick={logout}
            style={{
              padding: "0.35rem 0.75rem",
              background: "none",
              border: "1px solid #ccc",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            Sign out
          </button>
        </div>
      </div>
      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
        <Link to="/dashboard" activeOptions={{ exact: true }}>
          Overview
        </Link>
        <Link to="/dashboard/integrations">Integrations</Link>
        <Link to="/dashboard/projects">Projects</Link>
        <Link to="/dashboard/sessions">Sessions</Link>
      </nav>
      <Outlet />
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => dashboardLayout,
  path: "/dashboard",
  component: () => (
    <p>Welcome to the Linear Agent dashboard. Select a tab above.</p>
  ),
});

const integrationsRoute = createRoute({
  getParentRoute: () => dashboardLayout,
  path: "/dashboard/integrations",
  component: () => <h2>Integrations</h2>,
});

const projectsRoute = createRoute({
  getParentRoute: () => dashboardLayout,
  path: "/dashboard/projects",
  component: () => <h2>Projects</h2>,
});

const sessionsRoute = createRoute({
  getParentRoute: () => dashboardLayout,
  path: "/dashboard/sessions",
  component: () => <h2>Sessions</h2>,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  dashboardLayout.addChildren([
    indexRoute,
    integrationsRoute,
    projectsRoute,
    sessionsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  basepath: "/",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
