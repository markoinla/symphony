import {
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import * as Collapsible from '@radix-ui/react-collapsible'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard,
  Clock,
  FolderKanban,
  Settings,
  Bot,
  BarChart2,
  HeartPulse,
  LogOut,
  Sun,
  Moon,
  Menu,
  X,
  User,
} from 'lucide-react'

import {
  ApiError,
  getAuthStatus,
  logout,
} from './lib/api'
import { cn } from './lib/utils'
import { useTheme } from './hooks/use-theme'
import { Button } from './components/ui'

import {
  router,
  rootRoute,
  dashboardRoute,
  sessionRoute,
  historyRoute,
  projectsRoute,
  settingsRoute,
  agentsRoute,
  analyticsRoute,
  reliabilityRoute,
  loginRoute,
  setupRoute,
} from './router'

import { DashboardView } from './pages/dashboard'
import { SessionView } from './pages/session'
import { HistoryView } from './pages/history'
import { ProjectsView } from './pages/projects'
import { SettingsView } from './pages/settings'
import { AgentsView } from './pages/agents'
import { AnalyticsView } from './pages/analytics'
import { ReliabilityView } from './pages/reliability'
import { LoginView } from './pages/login'
import { SetupView } from './pages/setup'

function redirectToLoginOn401(error: Error) {
  if (error instanceof ApiError && error.status === 401) {
    const path = window.location.pathname
    if (path !== '/login' && path !== '/setup') {
      window.location.href = '/login'
    }
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false
        return failureCount < 1
      },
    },
    mutations: {
      onError: redirectToLoginOn401,
    },
  },
})

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'updated' && event.action.type === 'error') {
    redirectToLoginOn401(event.action.error)
  }
})

// Bind components to routes
rootRoute.update({ component: RootLayout, notFoundComponent: NotFoundView })
dashboardRoute.update({ component: DashboardView })
sessionRoute.update({ component: SessionView })
historyRoute.update({ component: HistoryView })
projectsRoute.update({ component: ProjectsView })
settingsRoute.update({ component: SettingsView })
agentsRoute.update({ component: AgentsView })
analyticsRoute.update({ component: AnalyticsView })
reliabilityRoute.update({ component: ReliabilityView })
loginRoute.update({ component: LoginView })
setupRoute.update({ component: SetupView })

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

const navItems = [
  { to: '/' as const, label: 'Dashboard', icon: LayoutDashboard, match: (p: string) => p === '/' },
  { to: '/history' as const, label: 'History', icon: Clock, match: (p: string) => p.startsWith('/history') },
  { to: '/projects' as const, label: 'Projects', icon: FolderKanban, match: (p: string) => p.startsWith('/projects') },
  { to: '/settings' as const, label: 'Settings', icon: Settings, match: (p: string) => p.startsWith('/settings') },
  { to: '/agents' as const, label: 'Agents', icon: Bot, match: (p: string) => p.startsWith('/agents') },
  { to: '/analytics' as const, label: 'Analytics', icon: BarChart2, match: (p: string) => p.startsWith('/analytics') },
  { to: '/reliability' as const, label: 'Reliability', icon: HeartPulse, match: (p: string) => p.startsWith('/reliability') },
]

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { dark, toggle } = useTheme()
  const [mobileNavState, setMobileNavState] = useState({ open: false, path: pathname })
  const mobileNavOpen = mobileNavState.path === pathname && mobileNavState.open

  const authQuery = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    retry: (failureCount, error) => {
      // Don't retry auth failures, but keep retrying network errors (backend not up yet)
      if (error instanceof ApiError) return false
      return failureCount < 10
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: 30_000,
  })

  const isLoginPage = pathname === '/login'
  const isSetupPage = pathname === '/setup'
  const isPublicPage = isLoginPage || isSetupPage

  useEffect(() => {
    if (!authQuery.data || isPublicPage) return
    if (authQuery.data.auth_required && !authQuery.data.authenticated) {
      window.location.href = '/login'
    } else if (!authQuery.data.auth_required) {
      window.location.href = '/setup'
    }
  }, [authQuery.data, isPublicPage])

  if (isPublicPage) {
    return <Outlet />
  }

  // Don't render child routes until auth resolves — prevents query spam when backend is starting
  if (authQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-th-bg text-th-text-4">
        <p className="text-sm">Connecting...</p>
      </div>
    )
  }

  const handleLogout = async () => {
    await logout()
    window.location.href = '/login'
  }

  const showLogout = authQuery.data?.auth_required && authQuery.data?.authenticated

  return (
    <div className="min-h-screen bg-th-bg text-th-text-2 transition-colors duration-200">
      <div className="mx-auto flex min-h-screen w-full max-w-[1120px] flex-col px-4 sm:px-6 lg:px-10">
        <Collapsible.Root
          className="border-b border-th-border"
          onOpenChange={(open) => setMobileNavState({ open, path: pathname })}
          open={mobileNavOpen}
        >
          <header className="flex min-h-14 items-center justify-between gap-3 py-3 md:py-0">
            <div className="flex min-w-0 items-center gap-3 sm:gap-8">
              <Link to="/" className="flex shrink-0 items-center gap-2.5">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-th-accent">
                  <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1l2.5 5h5L11 9.5l1.5 5.5L8 12l-4.5 3 1.5-5.5L0.5 6h5z" />
                  </svg>
                </div>
                <span className="text-sm font-semibold text-th-text-1">Symphony</span>
              </Link>

              <nav className="hidden min-w-0 items-center gap-0.5 md:flex">
                {navItems.map((item) => (
                  <Link
                    key={item.to}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-100',
                      item.match(pathname)
                        ? 'bg-th-muted text-th-text-1'
                        : 'text-th-text-3 hover:text-th-text-1',
                    )}
                    to={item.to}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="flex items-center gap-1">
              {showLogout && authQuery.data?.user && (
                <span className="mr-1 hidden items-center gap-1.5 text-[13px] text-th-text-3 sm:flex">
                  <User className="h-3.5 w-3.5" />
                  {authQuery.data.user.name || authQuery.data.user.email}
                </span>
              )}
              {showLogout && (
                <Button
                  aria-label="Sign out"
                  onClick={handleLogout}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              )}
              <Button
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick={toggle}
                size="icon"
                type="button"
                variant="ghost"
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>

              <Collapsible.Trigger asChild>
                <Button
                  aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
                  className="md:hidden"
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
                </Button>
              </Collapsible.Trigger>
            </div>
          </header>

          <Collapsible.Content className="border-t border-th-border/70 pb-3 md:hidden">
            <nav className="grid gap-1 pt-3">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-100',
                    item.match(pathname)
                      ? 'bg-th-muted text-th-text-1'
                      : 'text-th-text-3 hover:text-th-text-1',
                  )}
                  onClick={() => setMobileNavState((current) => ({ ...current, open: false }))}
                  to={item.to}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}
            </nav>
          </Collapsible.Content>
        </Collapsible.Root>

        <main className="flex-1 py-6 sm:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function NotFoundView() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-5xl font-semibold text-th-text-4">404</p>
      <p className="mt-3 text-sm font-medium text-th-text-2">Page not found</p>
      <p className="mt-1 text-[13px] text-th-text-4">
        This route doesn&apos;t exist.
      </p>
      <Link to="/" className="mt-6 text-sm font-medium text-th-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  )
}
