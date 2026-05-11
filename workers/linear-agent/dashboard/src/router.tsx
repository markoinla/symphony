import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  Link,
} from "@tanstack/react-router";
import { SessionsPage } from "./components/SessionsPage";

const rootRoute = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
      <h1 style={{ margin: "0 0 1rem" }}>Linear Agent</h1>
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
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: () => (
    <p>Welcome to the Linear Agent dashboard. Select a tab above.</p>
  ),
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard/integrations",
  component: () => <h2>Integrations</h2>,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard/projects",
  component: () => <h2>Projects</h2>,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard/sessions",
  component: SessionsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  integrationsRoute,
  projectsRoute,
  sessionsRoute,
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
