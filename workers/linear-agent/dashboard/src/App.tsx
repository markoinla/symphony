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
import { useEffect, useState } from 'react'
import {
  LayoutDashboard,
  Clock,
  FolderKanban,
  Settings,
  PlugZap,
  LogOut,
  Sun,
  Moon,
  Menu,
  User,
  Webhook,
  Workflow as WorkflowIcon,
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './components/ui/sheet'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInner,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { ChangelogButton } from './components/changelog-button'

import {
  router,
  rootRoute,
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
} from './router'

import { DashboardView } from './pages/dashboard'
import { SessionByIdView } from './pages/session-by-id'
import { HistoryView } from './pages/history'
import { WebhooksView } from './pages/webhooks'
import { ProjectsView } from './pages/projects'
import { WorkflowsView } from './pages/workflows'
import { WorkflowEditorView } from './pages/workflow-editor'
import { SettingsView } from './pages/settings'
import { IntegrationsView } from './pages/integrations'
import { LoginView } from './pages/login'
import { SetupView } from './pages/setup'
import { CreateOrganizationView } from './pages/create-organization'
import { authClient } from './lib/auth-client'

function redirectToLoginOn401(error: Error) {
  if (error instanceof ApiError && error.status === 401) {
    const path = window.location.pathname
    if (path !== '/login' && path !== '/setup') {
      window.location.href = '/dashboard/login'
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
sessionByIdRoute.update({ component: SessionByIdView })
historyRoute.update({ component: HistoryView })
webhooksRoute.update({ component: WebhooksView })
projectsRoute.update({ component: ProjectsView })
workflowsRoute.update({ component: WorkflowsView })
workflowEditorRoute.update({ component: WorkflowEditorView })
integrationsRoute.update({ component: IntegrationsView })
settingsRoute.update({ component: SettingsView })
loginRoute.update({ component: LoginView })
setupRoute.update({ component: SetupView })
createOrganizationRoute.update({ component: CreateOrganizationView })

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster richColors closeButton position="bottom-right" />
    </QueryClientProvider>
  )
}

const navItems = [
  { to: '/' as const, label: 'Dashboard', icon: LayoutDashboard, match: (p: string) => p === '/' },
  { to: '/history' as const, label: 'History', icon: Clock, match: (p: string) => p.startsWith('/history') },
  { to: '/webhooks' as const, label: 'Webhooks', icon: Webhook, match: (p: string) => p.startsWith('/webhooks') },
  { to: '/projects' as const, label: 'Projects', icon: FolderKanban, match: (p: string) => p.startsWith('/projects') },
  { to: '/workflows' as const, label: 'Workflows', icon: WorkflowIcon, match: (p: string) => p.startsWith('/workflows') },
  { to: '/integrations' as const, label: 'Integrations', icon: PlugZap, match: (p: string) => p.startsWith('/integrations') },
  { to: '/settings' as const, label: 'Settings', icon: Settings, match: (p: string) => p.startsWith('/settings') },
]

function LinearAgentLogo() {
  return (
    <Link to="/" className="flex min-w-0 shrink-0 items-center gap-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-th-accent shadow-xs">
        <svg className="h-4 w-4 text-white" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1l2.5 5h5L11 9.5l1.5 5.5L8 12l-4.5 3 1.5-5.5L0.5 6h5z" />
        </svg>
      </div>
      <div className="min-w-0">
        <span className="block truncate text-sm font-semibold text-th-text-1">
          Linear Agent
        </span>
        <span className="hidden truncate text-[11px] font-medium text-th-text-4 md:block">
          Operations dashboard
        </span>
      </div>
    </Link>
  )
}

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

  // pathname may or may not include the `/dashboard` basepath
  // depending on which API surfaces it (TanStack vs window.location).
  // Match defensively with endsWith so both shapes work.
  const isLoginPage = pathname === '/login' || pathname.endsWith('/login')
  const isSetupPage = pathname === '/setup' || pathname.endsWith('/setup')
  const isCreateOrgPage =
    pathname === '/create-organization' ||
    pathname.endsWith('/create-organization')
  // Public + onboarding pages render without the dashboard chrome.
  const isPublicPage = isLoginPage || isSetupPage
  const isChromeless = isPublicPage || isCreateOrgPage
  const session = authClient.useSession()
  const activeOrgId =
    (session.data?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null

  useEffect(() => {
    if (!authQuery.data || isPublicPage) return
    if (!authQuery.data.authenticated) {
      window.location.href = '/dashboard/login'
      return
    }
    // Authed but no active organization — push them to onboarding,
    // unless they're already on /create-organization.
    if (session.data && !activeOrgId && !isCreateOrgPage) {
      window.location.href = '/dashboard/create-organization'
    }
  }, [
    authQuery.data,
    session.data,
    activeOrgId,
    isPublicPage,
    isCreateOrgPage,
  ])

  if (isChromeless) {
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
    <SidebarProvider className="bg-th-bg text-th-text-2 transition-colors duration-200">
      <Sidebar>
        <SidebarInner>
          <SidebarHeader>
            <LinearAgentLogo />
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={item.match(pathname)}>
                      <Link to={item.to}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            {showLogout && authQuery.data?.user && (
              <div className="mb-3 flex min-w-0 items-center gap-2 rounded-lg bg-th-muted/70 px-3 py-2 text-[13px] text-th-text-2">
                <User className="h-4 w-4 shrink-0 text-th-text-4" />
                <span className="truncate">
                  {authQuery.data.user.name || authQuery.data.user.email}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <ChangelogButton />
                <Button
                  aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                  onClick={toggle}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </div>
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
            </div>
          </SidebarFooter>
        </SidebarInner>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-th-border bg-th-bg/95 px-4 py-3 backdrop-blur sm:px-6 md:hidden">
          <LinearAgentLogo />

          <div className="flex items-center gap-1">
            <ChangelogButton />
            <Button
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={toggle}
              size="icon"
              type="button"
              variant="ghost"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <Sheet
              open={mobileNavOpen}
              onOpenChange={(open) => setMobileNavState({ open, path: pathname })}
            >
              <SheetTrigger asChild>
                <Button
                  aria-label="Open navigation menu"
                  size="icon"
                  type="button"
                  variant="secondary"
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <nav className="grid gap-1 px-4">
                  {navItems.map((item) => (
                    <Link
                      key={item.to}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-100',
                        item.match(pathname)
                          ? 'bg-th-accent-muted text-th-text-1'
                          : 'text-th-text-3 hover:bg-th-muted hover:text-th-text-1',
                      )}
                      onClick={() => setMobileNavState((current) => ({ ...current, open: false }))}
                      to={item.to}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  ))}
                </nav>
                <div className="mt-auto border-t border-th-border px-4 pt-4">
                  {showLogout && authQuery.data?.user && (
                    <div className="mb-2 flex min-w-0 items-center gap-2 text-[13px] text-th-text-3">
                      <User className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {authQuery.data.user.name || authQuery.data.user.email}
                      </span>
                    </div>
                  )}
                  {showLogout && (
                    <Button
                      className="w-full justify-start"
                      onClick={handleLogout}
                      type="button"
                      variant="ghost"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign out
                    </Button>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarProvider>
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
