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

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$issueIdentifier',
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
  sessionRoute,
  historyRoute,
  webhooksRoute,
  projectsRoute,
  workflowsRoute,
  workflowEditorRoute,
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
