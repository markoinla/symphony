import { useMemo, useRef, useState, useEffect, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Eye,
  EyeOff,
  ExternalLink,
  Github,
  Globe,
  Key,
  Link2,
  Lock,
  Radio,
  Settings,
  Sliders,
  Trash2,
  RotateCcw,
} from 'lucide-react'

import {
  type AgentSettingsDefaults,
  type ProxyPingResult,
  type Setting,
  changePassword,
  deleteSetting,
  getIntegrations,
  getProxyStatus,
  getSettings,
  proxyPing,
  revokeOAuth,
  upsertSetting,
} from '../lib/api'
import { formatQueryError, isPositiveInteger } from '../lib/helpers'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui'
import {
  EmptyState,
  ErrorPanel,
  FeedbackBanner,
  LoadingPanel,
} from '../components/feedback'
import { Field } from '../components/field'

type AgentSettingKey =
  | 'agent.default_engine'
  | 'agent.default_model'
  | 'agent.max_turns'

type AgentSettingDefinition = {
  key: AgentSettingKey
  label: string
  description: string
  input: 'engine_select' | 'model_text' | 'integer'
  defaultValueKey: keyof AgentSettingsDefaults
}

const agentSettingDefinitions: AgentSettingDefinition[] = [
  {
    key: 'agent.default_engine',
    label: 'Default engine',
    description:
      'Engine to run when no workflow override is in effect. Only `pi` is supported end-to-end today; codex and claude-code support is planned.',
    input: 'engine_select',
    defaultValueKey: 'default_engine',
  },
  {
    key: 'agent.default_model',
    label: 'Default model',
    description:
      'Provider/model id passed to the engine when no workflow override is in effect. Format: `provider/id` (e.g. `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6`).',
    input: 'model_text',
    defaultValueKey: 'default_model',
  },
  {
    key: 'agent.max_turns',
    label: 'Max turns',
    description:
      'Caps how many turns a single issue can use before stopping. Workflow rows override this when a trigger matches.',
    input: 'integer',
    defaultValueKey: 'max_turns',
  },
]

const SUPPORTED_ENGINES = ['pi'] as const

const fallbackAgentSettings: AgentSettingsDefaults = {
  default_engine: 'pi',
  default_model: null,
  max_turns: 10,
}

function settingValue(settings: Setting[] | undefined, key: string) {
  return settings?.find((setting) => setting.key === key)?.value ?? null
}

function agentSettingLabel(key: string) {
  return agentSettingDefinitions.find((setting) => setting.key === key)?.label ?? key
}

function agentSettingDefaultValue(
  key: AgentSettingKey,
  agentDefaults?: AgentSettingsDefaults,
): string {
  const definition = agentSettingDefinitions.find((setting) => setting.key === key)
  if (!definition) return ''
  const resolved = (agentDefaults ?? fallbackAgentSettings)[definition.defaultValueKey]
  if (resolved === null || resolved === undefined) return ''
  return String(resolved)
}

function buildAgentSettingDrafts(
  settings: Setting[] | undefined,
  agentDefaults: AgentSettingsDefaults | undefined,
) {
  return Object.fromEntries(
    agentSettingDefinitions.map((setting) => [
      setting.key,
      settingValue(settings, setting.key) ??
        agentSettingDefaultValue(setting.key, agentDefaults),
    ]),
  )
}

function validateAgentSettingDraft(
  definition: AgentSettingDefinition,
  draft: string,
): string | null {
  const trimmed = draft.trim()
  switch (definition.input) {
    case 'engine_select':
      if (!SUPPORTED_ENGINES.includes(trimmed as (typeof SUPPORTED_ENGINES)[number])) {
        return 'Only `pi` is supported today.'
      }
      return null
    case 'model_text':
      if (trimmed.length === 0) return 'Model must not be empty.'
      return null
    case 'integer':
      if (!isPositiveInteger(trimmed)) return 'Enter a whole number greater than 0.'
      return null
  }
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
          <TabsTrigger value="security">
            <Lock className="mr-1.5 h-3.5 w-3.5" />
            Security
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
            <ProxySection />
            <DomainSection />
          </div>
        </TabsContent>

        <TabsContent value="agent">
          <AgentSettingsSection />
        </TabsContent>

        <TabsContent value="security">
          <ChangePasswordSection />
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
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-th-text-3" />
          <CardTitle>Linear API Key</CardTitle>
          {existing ? <Badge variant="running">Configured</Badge> : <Badge variant="secondary">Not set</Badge>}
        </div>
        <CardDescription>
          Required to connect Symphony to Linear. Get a personal API key from Linear Settings &rarr; Security &amp; access &rarr; Personal API keys.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
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
      </CardContent>
    </Card>
  )
}

function LinearOAuthSection() {
  const queryClient = useQueryClient()

  const integrationsQuery = useQuery({
    queryKey: ['integrations'],
    queryFn: getIntegrations,
    refetchInterval: 60_000,
  })

  const connected = integrationsQuery.data?.linear.connected ?? false
  const email = integrationsQuery.data?.linear.email ?? null

  const initialFeedback = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('oauth')
    if (oauthResult) {
      window.history.replaceState({}, '', window.location.pathname)
      if (oauthResult === 'success') return 'Successfully connected to Linear.'
      const message = params.get('message') || 'Unknown error'
      return `Linear OAuth failed: ${message}`
    }
    return null
  }, [])

  const [feedback, setFeedback] = useState<string | null>(initialFeedback)

  useEffect(() => {
    if (initialFeedback?.startsWith('Successfully')) {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] })
    }
  }, [initialFeedback, queryClient])

  const disconnectMutation = useMutation({
    mutationFn: revokeOAuth,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['integrations'] })
      setFeedback('Disconnected from Linear.')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const handleConnect = () => {
    setFeedback(null)
    window.location.href = '/linear/agent-install'
  }

  const statusBadge = connected ? (
    <Badge variant="running">Connected</Badge>
  ) : (
    <Badge variant="secondary">Disconnected</Badge>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-th-text-3" />
          <CardTitle>Linear</CardTitle>
          {statusBadge}
        </div>
        <CardDescription>
          Sign in with Linear so the agent can read issues and post comments on
          behalf of your workspace.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-th-text-2">
              {connected ? (
                <div>
                  Signed in as{' '}
                  <span className="text-th-text-1">{email ?? 'Linear workspace'}</span>
                </div>
              ) : (
                <div className="text-th-text-3">Not connected.</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {connected ? (
                <>
                  <Button onClick={handleConnect} size="sm" type="button" variant="secondary">
                    Reconnect
                  </Button>
                  <Button
                    disabled={disconnectMutation.isPending}
                    onClick={() => { setFeedback(null); void disconnectMutation.mutateAsync() }}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button onClick={handleConnect} type="button">
                  Sign in with Linear
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function GitHubOAuthSection() {
  const queryClient = useQueryClient()

  const integrationsQuery = useQuery({
    queryKey: ['integrations'],
    queryFn: getIntegrations,
    refetchInterval: 60_000,
  })

  const connected = integrationsQuery.data?.github.connected ?? false
  const repoSelection = integrationsQuery.data?.github.repo_selection ?? null
  const repoCount = integrationsQuery.data?.github.repo_count ?? null
  const settingsUrl = integrationsQuery.data?.github_app_settings_url ?? null

  const repoLabel =
    repoSelection === 'all'
      ? 'all repositories'
      : repoCount === null
        ? 'selected repositories'
        : `${repoCount} selected ${repoCount === 1 ? 'repository' : 'repositories'}`

  const initialFeedback = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('github_oauth')
    if (oauthResult) {
      window.history.replaceState({}, '', window.location.pathname)
      if (oauthResult === 'success') return 'GitHub App installed.'
      const message = params.get('message') || 'Unknown error'
      return `GitHub install failed: ${message}`
    }
    return null
  }, [])

  const [feedback, setFeedback] = useState<string | null>(initialFeedback)

  useEffect(() => {
    if (initialFeedback?.startsWith('GitHub App installed')) {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] })
    }
  }, [initialFeedback, queryClient])

  const handleInstall = () => {
    setFeedback(null)
    window.location.href = '/github/install'
  }

  const statusBadge = connected ? (
    <Badge variant="running">Installed</Badge>
  ) : (
    <Badge variant="secondary">Not installed</Badge>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-th-text-3" />
          <CardTitle>GitHub</CardTitle>
          {statusBadge}
        </div>
        <CardDescription>
          Install the GitHub App so the agent can push branches and open pull
          requests on your repositories.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-th-text-2">
              {connected ? (
                <div>
                  Installed on{' '}
                  <span className="text-th-text-1">{repoLabel}</span>
                </div>
              ) : (
                <div className="text-th-text-3">Not installed.</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {connected && settingsUrl ? (
                <a
                  href={settingsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-th-border bg-th-surface px-3 text-[13px] font-medium text-th-text-2 shadow-sm transition-all hover:bg-th-muted hover:text-th-text-1"
                >
                  Manage on GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              <Button
                onClick={handleInstall}
                size={connected ? 'sm' : 'default'}
                type="button"
                variant={connected ? 'secondary' : 'default'}
              >
                {connected ? 'Reconfigure' : 'Install GitHub App'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
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
    mutationFn: ({ key, value }: { key: AgentSettingKey; value: string }) => {
      const definition = agentSettingDefinitions.find((d) => d.key === key)
      if (!definition) throw new Error(`Unknown setting key: ${key}`)
      const error = validateAgentSettingDraft(definition, value)
      if (error) throw new Error(error)
      return upsertSetting(key, value.trim())
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
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-th-text-3" />
          <CardTitle>Agent Configuration</CardTitle>
        </div>
        <CardDescription>
          Configure the most common orchestration limits.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <div className="divide-y divide-th-border">
        {agentSettingDefinitions.map((setting) => {
          const persistedValue = settingValue(settings, setting.key)
          const defaultValue = agentSettingDefaultValue(setting.key, agentDefaults)
          const draftValue = drafts[setting.key] ?? defaultValue
          const trimmedDraft = draftValue.trim()
          const validationMessage =
            trimmedDraft === '' ? null : validateAgentSettingDraft(setting, draftValue)
          const displayedDefault = defaultValue === '' ? '(not set)' : defaultValue

          return (
            <div className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between" key={setting.key}>
              <div className="space-y-1 sm:max-w-sm">
                <h3 className="text-sm font-medium text-th-text-1">{setting.label}</h3>
                <p className="text-[13px] text-th-text-3">{setting.description}</p>
                <p className="text-xs text-th-text-4">
                  {persistedValue === null
                    ? `Default: ${displayedDefault}`
                    : `Override: ${persistedValue} (default: ${displayedDefault})`}
                </p>
                {validationMessage ? (
                  <p className="text-xs text-th-danger">{validationMessage}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {setting.input === 'engine_select' ? (
                  <Select
                    value={draftValue}
                    onValueChange={(value) => {
                      setDrafts((current) => ({ ...current, [setting.key]: value }))
                      setFeedback(null)
                    }}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder={defaultValue || 'Select…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_ENGINES.map((engine) => (
                        <SelectItem key={engine} value={engine}>
                          {engine}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : setting.input === 'model_text' ? (
                  <Input
                    className="w-72 font-mono text-xs"
                    onChange={(event) => {
                      setDrafts((current) => ({
                        ...current,
                        [setting.key]: event.target.value,
                      }))
                      setFeedback(null)
                    }}
                    placeholder={defaultValue || 'provider/model-id'}
                    type="text"
                    value={draftValue}
                  />
                ) : (
                  <Input
                    className="w-24 text-center"
                    inputMode="numeric"
                    min={1}
                    onChange={(event) => {
                      setDrafts((current) => ({
                        ...current,
                        [setting.key]: event.target.value,
                      }))
                      setFeedback(null)
                    }}
                    step={1}
                    type="number"
                    value={draftValue}
                  />
                )}
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
      </CardContent>
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
    'agent.default_engine',
    'agent.default_model',
    'agent.max_turns',
  ])

  const customSettings = settingsQuery.data?.settings.filter((s) => !managedKeys.has(s.key)) ?? []

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Custom Settings</CardTitle>
          <CardDescription>
            Raw key-value settings for the workflow config overlay. Managed settings (API keys, OAuth, agent limits) are shown in their respective tabs.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      {settingsQuery.isPending ? <LoadingPanel title="Loading settings" compact /> : null}
      {settingsQuery.isError ? <ErrorPanel detail={formatQueryError(settingsQuery.error)} title="Settings unavailable" /> : null}

      {customSettings.length > 0 ? (
        <Card className="gap-0 p-0 overflow-hidden">
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

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    onSuccess: () => {
      setFeedback('Password changed successfully.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setFeedback(null)

    if (newPassword.length < 8) {
      setFeedback('New password must be at least 8 characters.')
      return
    }

    if (newPassword !== confirmPassword) {
      setFeedback('New passwords do not match.')
      return
    }

    void mutation.mutateAsync()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-th-text-3" />
          <CardTitle>Change Password</CardTitle>
        </div>
        <CardDescription>
          Update the password used to sign in to the dashboard.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <Field label="Current Password">
            <Input
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              required
              type="password"
              value={currentPassword}
            />
          </Field>
          <Field label="New Password">
            <Input
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              required
              type="password"
              value={newPassword}
            />
          </Field>
          <Field label="Confirm New Password">
            <Input
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              required
              type="password"
              value={confirmPassword}
            />
          </Field>
          <Button
            disabled={mutation.isPending || !currentPassword || !newPassword || !confirmPassword}
            type="submit"
            variant="secondary"
          >
            {mutation.isPending ? 'Changing...' : 'Change password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ProxySection() {
  const queryClient = useQueryClient()
  const proxyQuery = useQuery({ queryKey: ['proxy-status'], queryFn: getProxyStatus })

  const proxyEnabled = proxyQuery.data?.enabled ?? true

  const [feedback, setFeedback] = useState<string | null>(null)
  const [pingResult, setPingResult] = useState<ProxyPingResult | null>(null)

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await upsertSetting('proxy.enabled', enabled ? 'true' : 'false')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['proxy-status'] })
      setFeedback(proxyEnabled ? 'Proxy disabled.' : 'Proxy enabled.')
      setPingResult(null)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const pingMutation = useMutation({
    mutationFn: proxyPing,
    onSuccess: (data) => {
      setPingResult(data)
      setFeedback(null)
    },
    onError: (error: unknown) => {
      setFeedback(formatQueryError(error))
      setPingResult(null)
    },
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-th-text-3" />
          <CardTitle>OAuth &amp; Webhook Proxy</CardTitle>
          {proxyEnabled ? <Badge variant="running">Enabled</Badge> : <Badge variant="secondary">Disabled</Badge>}
        </div>
        <CardDescription>
          Route OAuth flows and Linear webhooks through a Cloudflare Worker proxy. Required when Symphony is behind NAT or lacks a public URL.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <div className="flex items-center gap-3">
        <Button
          disabled={toggleMutation.isPending}
          onClick={() => {
            setFeedback(null)
            setPingResult(null)
            void toggleMutation.mutateAsync(!proxyEnabled)
          }}
          size="sm"
          type="button"
          variant={proxyEnabled ? 'destructive' : 'secondary'}
        >
          {proxyEnabled ? 'Disable proxy' : 'Enable proxy'}
        </Button>
        <Button
          disabled={pingMutation.isPending}
          onClick={() => {
            setFeedback(null)
            setPingResult(null)
            void pingMutation.mutateAsync()
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {pingMutation.isPending ? 'Testing...' : 'Test connectivity'}
        </Button>
      </div>

      {pingResult ? (
        <div className="space-y-2">
          <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${pingResult.proxy.ok ? 'border-th-success/30 bg-th-success/5 text-th-success' : 'border-th-danger/30 bg-th-danger/5 text-th-danger'}`}>
            <span>{pingResult.proxy.ok ? 'Pass' : 'Fail'}:</span>
            <span>{pingResult.proxy.ok ? 'Proxy is reachable' : `Proxy unreachable — ${pingResult.proxy.error ?? 'unknown error'}`}</span>
          </div>
          <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${pingResult.webhook.ok ? 'border-th-success/30 bg-th-success/5 text-th-success' : 'border-th-danger/30 bg-th-danger/5 text-th-danger'}`}>
            <span>{pingResult.webhook.ok ? 'Pass' : 'Fail'}:</span>
            <span>
              {pingResult.webhook.ok
                ? 'Proxy can reach this instance — webhook forwarding will work'
                : pingResult.webhook.registered === false
                  ? 'No instance registered with proxy. Connect Linear OAuth or set a domain first.'
                  : `Proxy cannot reach this instance — ${pingResult.webhook.error ?? 'unknown error'}`}
            </span>
          </div>
          {!pingResult.webhook.ok && pingResult.webhook.registered !== false ? (
            <div className="space-y-1">
              <p className="text-xs text-th-text-4">
                Webhook forwarding requires a publicly accessible URL. If you are behind NAT, use a tunnel (e.g. cloudflared) and set the tunnel URL as your domain above.
              </p>
              {pingResult.webhook.response_body ? (
                <details className="text-xs text-th-text-4">
                  <summary className="cursor-pointer">Response details</summary>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-th-bg-3 p-2 font-mono text-[11px]">
                    {pingResult.webhook.response_server ? `Server: ${pingResult.webhook.response_server}\n` : ''}
                    {pingResult.webhook.response_body}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Instance URL">
              <p className="text-sm text-th-text-2">
                {proxyQuery.data?.instance_url || <span className="text-th-text-4">Not resolved yet</span>}
              </p>
              <p className="mt-1 text-xs text-th-text-4">
                Resolved from public base URL or server IP. Set in the Domain section above.
              </p>
            </Field>
            <Field label="Linear Organization ID">
              <p className="text-sm text-th-text-2">
                {proxyQuery.data?.linear_org_id || <span className="text-th-text-4">Automatically set after Linear OAuth</span>}
              </p>
              <p className="mt-1 text-xs text-th-text-4">
                Synced automatically when you connect Linear.
              </p>
            </Field>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function DomainSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const existing = settingsQuery.data?.settings.find((s) => s.key === 'domain')

  const [domain, setDomain] = useState(existing?.value ?? '')
  const [feedback, setFeedback] = useState<string | null>(null)

  const prevExisting = useRef(existing?.value)
  if (existing?.value !== prevExisting.current) {
    prevExisting.current = existing?.value
    if (existing) setDomain(existing.value)
  }

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('domain', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Domain saved.')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('domain'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setFeedback('Domain removed.')
      setDomain('')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-th-text-3" />
          <CardTitle>Domain</CardTitle>
          {existing ? <Badge variant="running">Configured</Badge> : <Badge variant="secondary">Not set</Badge>}
        </div>
        <CardDescription>
          Configure a custom domain for HTTPS access.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {feedback ? <FeedbackBanner message={feedback} /> : null}

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            setFeedback(null)
            void saveMutation.mutateAsync(domain.trim())
          }}
        >
          <Field label="Domain name">
            <Input
              onChange={(e) => setDomain(e.target.value)}
              placeholder="symphony.example.com"
              required
              value={domain}
            />
            <p className="mt-1.5 text-xs text-th-text-4">
              Point your domain's DNS A record to this server's IP before saving.
            </p>
          </Field>
          <div className="flex items-center gap-3">
            <Button
              disabled={saveMutation.isPending || !domain.trim()}
              type="submit"
              variant="secondary"
            >
              {existing ? 'Update' : 'Save'}
            </Button>
            {existing ? (
              <Button
                disabled={removeMutation.isPending}
                onClick={() => {
                  setFeedback(null)
                  void removeMutation.mutateAsync()
                }}
                type="button"
                variant="destructive"
              >
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
