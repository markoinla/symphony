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

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
})

export const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
})

export const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
})

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
})

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  sessionRoute,
  historyRoute,
  projectsRoute,
  settingsRoute,
  agentsRoute,
  analyticsRoute,
  loginRoute,
])

export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
