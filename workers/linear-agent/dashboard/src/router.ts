import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

// Routes are defined with lazy component imports in App.tsx.
// This file exports the route definitions for use in page components.
// The actual component binding happens in App.tsx.

export const rootRoute = createRootRoute()

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
})

// Session detail keyed by session UUID. This is the URL we post into
// Linear's AgentSession `externalUrls` ("Open in Symphony") — Linear
// only knows the session id, not the per-issue identifier, so we
// route off it directly. See `workers/linear-agent/src/workflows/
// session-runner.ts` where the URL is generated.
export const sessionByIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
})

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
})

export const webhooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhooks',
})

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
})

export const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
})

export const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/$id',
})

export const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations',
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
})

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
})

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
})

export const createOrganizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/create-organization',
})

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  sessionByIdRoute,
  historyRoute,
  webhooksRoute,
  projectsRoute,
  workflowsRoute,
  workflowEditorRoute,
  integrationsRoute,
  settingsRoute,
  loginRoute,
  setupRoute,
  createOrganizationRoute,
])

export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreload: 'intent',
  // SPA is mounted at `/dashboard/*` by the Worker (see
  // src/routes/dashboard.ts). Route paths are still authored relative
  // to root (`/`, `/login`, ...); the router prepends `/dashboard` to
  // every <Link href> and matches against the URL with that prefix
  // stripped.
  basepath: '/dashboard',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
