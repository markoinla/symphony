import { useMemo, useState, useEffect, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Eye,
  EyeOff,
  ExternalLink,
  Github,
  Key,
  Link2,
  Globe,
  Settings,
  Sliders,
  Trash2,
  RotateCcw,
} from 'lucide-react'

import {
  type AgentSettingsDefaults,
  type Setting,
  deleteSetting,
  getGitHubOAuthAuthorizeUrl,
  getGitHubOAuthStatus,
  getOAuthAuthorizeUrl,
  getOAuthStatus,
  getSettings,
  revokeGitHubOAuth,
  revokeOAuth,
  upsertSetting,
} from '../lib/api'
import { formatDateTime } from '../lib/utils'
import { formatQueryError, isPositiveInteger } from '../lib/helpers'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  EmptyState,
  ErrorPanel,
  FeedbackBanner,
  Field,
  Input,
  LoadingPanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui'

type AgentSettingDefinition = {
  key: 'agent.max_concurrent_agents' | 'agent.max_turns'
  label: string
  description: string
  defaultValueKey: keyof AgentSettingsDefaults
}

const agentSettingDefinitions: AgentSettingDefinition[] = [
  {
    key: 'agent.max_concurrent_agents',
    label: 'Number of agents',
    description: 'Limits how many issues Symphony can run at the same time.',
    defaultValueKey: 'max_concurrent_agents',
  },
  {
    key: 'agent.max_turns',
    label: 'Max turns',
    description: 'Caps how many Codex turns a single issue can use before stopping.',
    defaultValueKey: 'max_turns',
  },
]

const fallbackAgentSettings: AgentSettingsDefaults = {
  max_concurrent_agents: 10,
  max_turns: 20,
}

function settingValue(settings: Setting[] | undefined, key: string) {
  return settings?.find((setting) => setting.key === key)?.value ?? null
}

function agentSettingLabel(key: string) {
  return agentSettingDefinitions.find((setting) => setting.key === key)?.label ?? key
}

function agentSettingDefaultValue(key: string, agentDefaults?: AgentSettingsDefaults) {
  const definition = agentSettingDefinitions.find((setting) => setting.key === key)
  if (!definition) return 1
  return (agentDefaults ?? fallbackAgentSettings)[definition.defaultValueKey]
}

function buildAgentSettingDrafts(
  settings: Setting[] | undefined,
  agentDefaults: AgentSettingsDefaults | undefined,
) {
  return Object.fromEntries(
    agentSettingDefinitions.map((setting) => [
      setting.key,
      settingValue(settings, setting.key) ?? String(agentSettingDefaultValue(setting.key, agentDefaults)),
    ]),
  )
}

export function SettingsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Settings</h1>
        <p className="mt-1 text-sm text-th-text-3">
          Manage connections, agent configuration, and system preferences.
        </p>
      </div>

      <Tabs defaultValue="integrations">
        <TabsList>
          <TabsTrigger value="integrations">
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            Integrations
          </TabsTrigger>
          <TabsTrigger value="agent">
            <Sliders className="mr-1.5 h-3.5 w-3.5" />
            Agent
          </TabsTrigger>
          <TabsTrigger value="advanced">
            <Settings className="mr-1.5 h-3.5 w-3.5" />
            Advanced
          </TabsTrigger>
        </TabsList>

        <TabsContent value="integrations">
          <div className="space-y-5">
            <LinearApiKeySection />
            <LinearOAuthSection />
            <GitHubOAuthSection />
            <DashboardUrlSection />
          </div>
        </TabsContent>

        <TabsContent value="agent">
          <AgentSettingsSection />
        </TabsContent>

        <TabsContent value="advanced">
          <AdvancedSettingsSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function LinearApiKeySection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const existing = settingsQuery.data?.settings.find((s) => s.key === 'tracker.api_key')

  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('tracker.api_key', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Linear API key saved.')
      setApiKey('')
      setShowKey(false)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('tracker.api_key'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Linear API key removed.')
      setApiKey('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const maskedValue = existing
    ? existing.value.slice(0, 8) + '\u2022'.repeat(Math.max(0, existing.value.length - 8))
    : null

  return (
    <Card className="space-y-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-th-text-3" />
          <CardTitle>Linear API Key</CardTitle>
          {existing ? <Badge tone="running">Configured</Badge> : <Badge tone="neutral">Not set</Badge>}
        </div>
        <CardDescription>
          Required to connect Symphony to Linear. Get a personal API key from Linear Settings &rarr; Security &amp; access &rarr; Personal API keys.
        </CardDescription>
      </CardHeader>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      {existing ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-th-border bg-th-inset px-4 py-3">
          <code className="min-w-0 break-all text-sm text-th-text-2">
            {showKey ? existing.value : maskedValue}
          </code>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              aria-label={showKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowKey(!showKey)}
              size="icon"
              type="button"
              variant="ghost"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              aria-label="Remove key"
              disabled={removeMutation.isPending}
              onClick={() => {
                setFeedback(null)
                void removeMutation.mutateAsync()
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2 className="h-4 w-4 text-th-danger" />
            </Button>
          </div>
        </div>
      ) : null}

      <form
        className="flex gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setFeedback(null)
          void saveMutation.mutateAsync(apiKey.trim())
        }}
      >
        <Input
          className="flex-1"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="lin_api_..."
          required
          type="password"
          value={apiKey}
        />
        <Button disabled={saveMutation.isPending || !apiKey.trim()} type="submit" variant="secondary">
          {existing ? 'Update' : 'Save'}
        </Button>
      </form>
    </Card>
  )
}

function LinearOAuthSection() {
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['oauth-status'],
    queryFn: getOAuthStatus,
    refetchInterval: 60_000,
  })

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const existingClientId = settingsQuery.data?.settings.find((s) => s.key === 'linear_oauth.client_id')
  const existingExpiresAt = settingsQuery.data?.settings.find((s) => s.key === 'linear_oauth.expires_at')

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const oauthStatus = statusQuery.data?.status ?? 'disconnected'
  const credentialsSource = statusQuery.data?.credentials_source ?? 'none'
  const credentialsFromEnv = credentialsSource === 'env'

  const initialFeedback = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('oauth')
    if (oauthResult) {
      window.history.replaceState({}, '', window.location.pathname)
      if (oauthResult === 'success') return 'Successfully connected to Linear.'
      const message = params.get('message') || 'Unknown error'
      return `OAuth authorization failed: ${message}`
    }
    return null
  }, [])

  const [feedback, setFeedback] = useState<string | null>(initialFeedback)

  useEffect(() => {
    if (initialFeedback?.startsWith('Successfully')) {
      void queryClient.invalidateQueries({ queryKey: ['oauth-status'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  }, [initialFeedback, queryClient])

  const saveCredentialsMutation = useMutation({
    mutationFn: async ({ id, secret }: { id: string; secret: string }) => {
      await upsertSetting('linear_oauth.client_id', id)
      await upsertSetting('linear_oauth.client_secret', secret)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('OAuth app credentials saved.')
      setClientId('')
      setClientSecret('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const connectMutation = useMutation({
    mutationFn: getOAuthAuthorizeUrl,
    onSuccess: (data) => { window.location.href = data.authorize_url },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const disconnectMutation = useMutation({
    mutationFn: revokeOAuth,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['oauth-status'] })
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Disconnected from Linear.')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const statusBadge =
    oauthStatus === 'connected' ? (
      <Badge tone="running">Connected</Badge>
    ) : oauthStatus === 'expired' ? (
      <Badge tone="retrying">Token expired</Badge>
    ) : (
      <Badge tone="neutral">Disconnected</Badge>
    )

  return (
    <Card className="space-y-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-th-text-3" />
          <CardTitle>Linear OAuth App</CardTitle>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Symphony to Linear using OAuth so agent activities are attributed to the app.
        </CardDescription>
      </CardHeader>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      {oauthStatus === 'connected' || oauthStatus === 'expired' ? (
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 text-sm text-th-text-2">
              {existingClientId ? (
                <div>App ID: <code className="text-th-text-3">{existingClientId.value}</code></div>
              ) : credentialsFromEnv ? (
                <div className="text-xs text-th-text-4">Credentials: via environment variable</div>
              ) : null}
              {existingExpiresAt ? (
                <div className="text-xs text-th-text-4">Token expires: {formatDateTime(existingExpiresAt.value)}</div>
              ) : (
                <div className="text-xs text-th-text-4">Token: via environment variable</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {oauthStatus === 'expired' ? (
                <Button
                  disabled={connectMutation.isPending}
                  onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
                  size="sm"
                  type="button"
                >
                  Reconnect
                </Button>
              ) : null}
              <Button
                disabled={disconnectMutation.isPending}
                onClick={() => { setFeedback(null); void disconnectMutation.mutateAsync() }}
                size="sm"
                type="button"
                variant="danger"
              >
                Disconnect
              </Button>
            </div>
          </div>
        </div>
      ) : credentialsFromEnv ? (
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 text-sm text-th-text-2">
              <div className="text-xs text-th-text-4">Credentials: via environment variable</div>
            </div>
            <Button
              disabled={connectMutation.isPending}
              onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
              type="button"
            >
              Connect to Linear
            </Button>
          </div>
        </div>
      ) : (
        <>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              setFeedback(null)
              void saveCredentialsMutation.mutateAsync({ id: clientId.trim(), secret: clientSecret.trim() })
            }}
          >
            <Field label="OAuth App ID (Client ID)">
              <Input
                onChange={(event) => setClientId(event.target.value)}
                placeholder={existingClientId?.value || 'Your Linear app client ID'}
                value={clientId}
              />
            </Field>
            <Field label="OAuth App Secret (Client Secret)">
              <Input
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="lin_oauth_..."
                type="password"
                value={clientSecret}
              />
            </Field>
            <div className="sm:col-span-2 flex gap-3">
              <Button
                disabled={saveCredentialsMutation.isPending || (!clientId.trim() && !clientSecret.trim())}
                type="submit"
                variant="secondary"
              >
                {existingClientId ? 'Update credentials' : 'Save credentials'}
              </Button>
              {existingClientId ? (
                <Button
                  disabled={connectMutation.isPending}
                  onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
                  type="button"
                >
                  Connect to Linear
                </Button>
              ) : null}
            </div>
          </form>
        </>
      )}
    </Card>
  )
}

function GitHubOAuthSection() {
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['github-oauth-status'],
    queryFn: getGitHubOAuthStatus,
    refetchInterval: 60_000,
  })

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const existingClientId = settingsQuery.data?.settings.find((s) => s.key === 'github_oauth.client_id')

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const oauthStatus = statusQuery.data?.status ?? 'disconnected'
  const credentialsSource = statusQuery.data?.credentials_source ?? 'none'
  const credentialsFromEnv = credentialsSource === 'env'

  const initialFeedback = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('github_oauth')
    if (oauthResult) {
      window.history.replaceState({}, '', window.location.pathname)
      if (oauthResult === 'success') return 'Successfully connected to GitHub.'
      const message = params.get('message') || 'Unknown error'
      return `GitHub OAuth authorization failed: ${message}`
    }
    return null
  }, [])

  const [feedback, setFeedback] = useState<string | null>(initialFeedback)

  useEffect(() => {
    if (initialFeedback?.startsWith('Successfully')) {
      void queryClient.invalidateQueries({ queryKey: ['github-oauth-status'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  }, [initialFeedback, queryClient])

  const saveCredentialsMutation = useMutation({
    mutationFn: async ({ id, secret }: { id: string; secret: string }) => {
      if (id) await upsertSetting('github_oauth.client_id', id)
      if (secret) await upsertSetting('github_oauth.client_secret', secret)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('GitHub OAuth app credentials saved.')
      setClientId('')
      setClientSecret('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const connectMutation = useMutation({
    mutationFn: getGitHubOAuthAuthorizeUrl,
    onSuccess: (data) => { window.location.href = data.authorize_url },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const disconnectMutation = useMutation({
    mutationFn: revokeGitHubOAuth,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['github-oauth-status'] })
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Disconnected from GitHub.')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const statusBadge =
    oauthStatus === 'connected' ? (
      <Badge tone="running">Connected</Badge>
    ) : oauthStatus === 'expired' ? (
      <Badge tone="retrying">Token expired</Badge>
    ) : (
      <Badge tone="neutral">Disconnected</Badge>
    )

  return (
    <Card className="space-y-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-th-text-3" />
          <CardTitle>GitHub OAuth</CardTitle>
          {statusBadge}
        </div>
        <CardDescription>
          Connect Symphony to GitHub to link repositories to projects.
        </CardDescription>
      </CardHeader>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      {oauthStatus === 'connected' || oauthStatus === 'expired' ? (
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 text-sm text-th-text-2">
              {existingClientId ? (
                <div>App ID: <code className="text-th-text-3">{existingClientId.value}</code></div>
              ) : credentialsFromEnv ? (
                <div className="text-xs text-th-text-4">Credentials: via environment variable</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {oauthStatus === 'expired' ? (
                <Button
                  disabled={connectMutation.isPending}
                  onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
                  size="sm"
                  type="button"
                >
                  Reconnect
                </Button>
              ) : null}
              <Button
                disabled={disconnectMutation.isPending}
                onClick={() => { setFeedback(null); void disconnectMutation.mutateAsync() }}
                size="sm"
                type="button"
                variant="danger"
              >
                Disconnect
              </Button>
            </div>
          </div>
        </div>
      ) : credentialsFromEnv ? (
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 text-sm text-th-text-2">
              <div className="text-xs text-th-text-4">Credentials: via environment variable</div>
            </div>
            <Button
              disabled={connectMutation.isPending}
              onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
              type="button"
            >
              Connect to GitHub
            </Button>
          </div>
        </div>
      ) : (
        <>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              setFeedback(null)
              void saveCredentialsMutation.mutateAsync({ id: clientId.trim(), secret: clientSecret.trim() })
            }}
          >
            <Field label="Client ID">
              <Input
                onChange={(event) => setClientId(event.target.value)}
                placeholder={existingClientId?.value || 'Your GitHub OAuth App client ID'}
                value={clientId}
              />
            </Field>
            <Field label="Client Secret">
              <Input
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Your GitHub OAuth App client secret"
                type="password"
                value={clientSecret}
              />
            </Field>
            <div className="sm:col-span-2 flex gap-3">
              <Button
                disabled={saveCredentialsMutation.isPending || (!clientId.trim() && !clientSecret.trim())}
                type="submit"
                variant="secondary"
              >
                {existingClientId ? 'Update credentials' : 'Save credentials'}
              </Button>
              {existingClientId ? (
                <Button
                  disabled={connectMutation.isPending}
                  onClick={() => { setFeedback(null); void connectMutation.mutateAsync() }}
                  type="button"
                >
                  Connect to GitHub
                </Button>
              ) : null}
            </div>
          </form>
        </>
      )}
    </Card>
  )
}

function DashboardUrlSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const existing = settingsQuery.data?.settings.find((s) => s.key === 'server.public_base_url')

  const [url, setUrl] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('server.public_base_url', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Dashboard URL saved.')
      setUrl('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('server.public_base_url'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Dashboard URL removed.')
      setUrl('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  return (
    <Card className="space-y-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-th-text-3" />
          <CardTitle>Dashboard URL</CardTitle>
          {existing ? <Badge tone="running">Set</Badge> : null}
        </div>
        <CardDescription>
          Public base URL used in session links posted to Linear issues. Include the scheme and host.
        </CardDescription>
      </CardHeader>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      {existing ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-th-border bg-th-inset px-4 py-3">
          <code className="min-w-0 break-all text-sm text-th-text-2">{existing.value}</code>
          <Button
            aria-label="Remove URL"
            disabled={removeMutation.isPending}
            onClick={() => { setFeedback(null); void removeMutation.mutateAsync() }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-4 w-4 text-th-danger" />
          </Button>
        </div>
      ) : null}

      <form
        className="flex gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setFeedback(null)
          void saveMutation.mutateAsync(url.trim())
        }}
      >
        <Input
          className="flex-1"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://my-server:4000"
          required
          type="url"
          value={url}
        />
        <Button disabled={saveMutation.isPending || !url.trim()} type="submit" variant="secondary">
          {existing ? 'Update' : 'Save'}
        </Button>
      </form>
    </Card>
  )
}

function AgentSettingsSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const agentDefaults = settingsQuery.data?.agent_defaults
  const settings = settingsQuery.data?.settings

  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    buildAgentSettingDrafts(settings, agentDefaults),
  )
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    setDrafts(buildAgentSettingDrafts(settings, agentDefaults))
  }, [agentDefaults, settings])

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => {
      const trimmed = value.trim()
      if (!isPositiveInteger(trimmed)) throw new Error('Enter a whole number greater than 0.')
      return upsertSetting(key, trimmed)
    },
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback(`${agentSettingLabel(variables.key)} saved.`)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: async (key: string) => { await deleteSetting(key); return key },
    onSuccess: async (key) => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback(`${agentSettingLabel(key)} reset to the default value.`)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  if (settingsQuery.isPending) return <LoadingPanel title="Loading agent settings" />
  if (settingsQuery.isError) return <ErrorPanel detail={formatQueryError(settingsQuery.error)} title="Agent settings unavailable" />

  return (
    <Card className="space-y-5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-th-text-3" />
          <CardTitle>Agent Configuration</CardTitle>
        </div>
        <CardDescription>
          Configure the most common orchestration limits.
        </CardDescription>
      </CardHeader>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      <div className="divide-y divide-th-border">
        {agentSettingDefinitions.map((setting) => {
          const persistedValue = settingValue(settings, setting.key)
          const defaultValue = agentSettingDefaultValue(setting.key, agentDefaults)
          const draftValue = drafts[setting.key] ?? String(defaultValue)
          const trimmedDraft = draftValue.trim()
          const validationMessage =
            trimmedDraft === '' || isPositiveInteger(trimmedDraft)
              ? null
              : 'Enter a whole number greater than 0.'

          return (
            <div className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between" key={setting.key}>
              <div className="space-y-1 sm:max-w-sm">
                <h3 className="text-sm font-medium text-th-text-1">{setting.label}</h3>
                <p className="text-[13px] text-th-text-3">{setting.description}</p>
                <p className="text-xs text-th-text-4">
                  {persistedValue === null
                    ? `Default: ${defaultValue}`
                    : `Override: ${persistedValue} (default: ${defaultValue})`}
                </p>
                {validationMessage ? (
                  <p className="text-xs text-th-danger">{validationMessage}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Input
                  className="w-24 text-center"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => {
                    setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                    setFeedback(null)
                  }}
                  step={1}
                  type="number"
                  value={draftValue}
                />
                <Button
                  disabled={
                    settingsQuery.isPending ||
                    saveMutation.isPending ||
                    removeMutation.isPending ||
                    validationMessage !== null ||
                    trimmedDraft === ''
                  }
                  onClick={() => {
                    setFeedback(null)
                    void saveMutation.mutateAsync({ key: setting.key, value: trimmedDraft })
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Save
                </Button>
                {persistedValue !== null ? (
                  <Button
                    aria-label="Reset to default"
                    disabled={saveMutation.isPending || removeMutation.isPending}
                    onClick={() => {
                      setFeedback(null)
                      void removeMutation.mutateAsync(setting.key)
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function AdvancedSettingsSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })

  const [keyValue, setKeyValue] = useState('')
  const [settingValueStr, setSettingValueStr] = useState('')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => upsertSetting(key, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback(editingKey === null ? 'Setting saved.' : 'Setting updated.')
      setKeyValue('')
      setSettingValueStr('')
      setEditingKey(null)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: deleteSetting,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Setting deleted.')
      setKeyValue('')
      setSettingValueStr('')
      setEditingKey(null)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setFeedback(null)
    void saveMutation.mutateAsync({ key: keyValue.trim(), value: settingValueStr })
  }

  // Filter out settings already managed by other sections
  const managedKeys = new Set([
    'tracker.api_key',
    'linear_oauth.client_id',
    'linear_oauth.client_secret',
    'linear_oauth.expires_at',
    'github_oauth.client_id',
    'github_oauth.client_secret',
    'github_oauth.expires_at',
    'server.public_base_url',
    'agent.max_concurrent_agents',
    'agent.max_turns',
  ])

  const customSettings = settingsQuery.data?.settings.filter((s) => !managedKeys.has(s.key)) ?? []

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <CardHeader>
          <CardTitle>Custom Settings</CardTitle>
          <CardDescription>
            Raw key-value settings for the workflow config overlay. Managed settings (API keys, OAuth, agent limits) are shown in their respective tabs.
          </CardDescription>
        </CardHeader>

        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Key">
              <Input
                onChange={(event) => setKeyValue(event.target.value)}
                placeholder="workspace.root"
                required
                value={keyValue}
              />
            </Field>
            <Field label="Value">
              <Input
                onChange={(event) => setSettingValueStr(event.target.value)}
                placeholder="~/code/symphony-workspaces"
                required
                value={settingValueStr}
              />
            </Field>
          </div>

          <div className="flex items-center gap-3">
            <Button disabled={saveMutation.isPending} type="submit" variant="secondary">
              {editingKey === null ? 'Add setting' : 'Update setting'}
            </Button>
            {editingKey !== null ? (
              <Button
                onClick={() => {
                  setEditingKey(null)
                  setKeyValue('')
                  setSettingValueStr('')
                  setFeedback(null)
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      {settingsQuery.isPending ? <LoadingPanel title="Loading settings" compact /> : null}
      {settingsQuery.isError ? <ErrorPanel detail={formatQueryError(settingsQuery.error)} title="Settings unavailable" /> : null}

      {customSettings.length > 0 ? (
        <Card className="space-y-1 p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3 sm:px-6">
            <CardTitle className="text-sm">Stored settings</CardTitle>
          </div>
          <div className="divide-y divide-th-border">
            {customSettings.map((setting) => (
              <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6" key={setting.key}>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-th-text-1">{setting.key}</div>
                  <div className="mt-0.5 truncate font-mono text-xs text-th-text-3">{setting.value}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    onClick={() => {
                      setEditingKey(setting.key)
                      setKeyValue(setting.key)
                      setSettingValueStr(setting.value)
                      setFeedback(null)
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={removeMutation.isPending}
                    onClick={() => {
                      setFeedback(null)
                      void removeMutation.mutateAsync(setting.key)
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-th-danger" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : !settingsQuery.isPending ? (
        <EmptyState
          title="No custom settings"
          description="Add key-value settings above. They'll appear here once saved."
        />
      ) : null}
    </div>
  )
}
