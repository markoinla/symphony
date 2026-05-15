import { useRef, useState, useEffect, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Github,
  Globe,
  Key,
  KeyRound,
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
  type ApiToken,
  type ApiTokenScope,
  type ApiTokenWithPlaintext,
  type ProxyPingResult,
  type Setting,
  changePassword,
  createWebhookSource,
  createApiToken,
  deleteApiToken,
  deleteSetting,
  getIntegrations,
  getProxyStatus,
  getSettings,
  listWebhookSources,
  listApiTokens,
  proxyPing,
  revokeOAuth,
  updateWebhookSource,
  upsertSetting,
} from '../lib/api'
import { formatQueryError, isPositiveInteger } from '../lib/helpers'
import {
  Badge,
  Button,
  Checkbox,
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
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  EmptyState,
  ErrorPanel,
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
          <TabsTrigger value="api-tokens">
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            API tokens
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
            <SentryWebhookSection />
            <GenericWebhookSection />
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

        <TabsContent value="api-tokens">
          <ApiTokensSection />
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

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('tracker.api_key', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Linear API key saved.')
      setApiKey('')
      setShowKey(false)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('tracker.api_key'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Linear API key removed.')
      setApiKey('')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
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
                onClick={() => void removeMutation.mutateAsync()}
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('oauth')
    if (!oauthResult) return
    window.history.replaceState({}, '', window.location.pathname)
    if (oauthResult === 'success') {
      toast.success('Successfully connected to Linear.')
      void queryClient.invalidateQueries({ queryKey: ['integrations'] })
    } else {
      const message = params.get('message') || 'Unknown error'
      toast.error(`Linear OAuth failed: ${message}`)
    }
  }, [queryClient])

  const disconnectMutation = useMutation({
    mutationFn: revokeOAuth,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['integrations'] })
      toast.success('Disconnected from Linear.')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const handleConnect = () => {
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
                    onClick={() => void disconnectMutation.mutateAsync()}
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthResult = params.get('github_oauth')
    if (!oauthResult) return
    window.history.replaceState({}, '', window.location.pathname)
    if (oauthResult === 'success') {
      toast.success('GitHub App installed.')
      void queryClient.invalidateQueries({ queryKey: ['integrations'] })
    } else {
      const message = params.get('message') || 'Unknown error'
      toast.error(`GitHub install failed: ${message}`)
    }
  }, [queryClient])

  const handleInstall = () => {
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
                <Button asChild size="sm" variant="outline">
                  <a href={settingsUrl} target="_blank" rel="noopener noreferrer">
                    Manage on GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
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

function SentryWebhookSection() {
  const queryClient = useQueryClient()
  const sourcesQuery = useQuery({ queryKey: ['webhook-sources'], queryFn: listWebhookSources })
  const source = sourcesQuery.data?.webhook_sources.find((s) => s.kind === 'sentry')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: () => createWebhookSource({ kind: 'sentry', name: 'Sentry', enabled: true }),
    onSuccess: async ({ webhook_source }) => {
      setCreatedSecret(webhook_source.secret ?? null)
      await queryClient.invalidateQueries({ queryKey: ['webhook-sources'] })
      toast.success('Sentry webhook source created. Copy the secret now.')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const rotateMutation = useMutation({
    mutationFn: (id: string) => updateWebhookSource(id, { rotate_secret: true }),
    onSuccess: async ({ webhook_source }) => {
      setCreatedSecret(webhook_source.secret ?? null)
      await queryClient.invalidateQueries({ queryKey: ['webhook-sources'] })
      toast.success('Sentry HMAC secret rotated. Copy the new secret now.')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} copied.`)
  }

  const inboundUrl = source?.inbound_url
  const secret = createdSecret ?? source?.secret ?? null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-th-text-3" />
          <CardTitle>Sentry</CardTitle>
          {source ? <Badge variant={source.enabled ? 'running' : 'secondary'}>{source.enabled ? 'Connected' : 'Disabled'}</Badge> : <Badge variant="secondary">Not connected</Badge>}
        </div>
        <CardDescription>
          Create an inbound URL and HMAC secret for a Sentry internal integration. Paste these values into Sentry's webhook URL and secret fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!source ? (
          <Button disabled={createMutation.isPending} onClick={() => void createMutation.mutateAsync()} type="button">
            {createMutation.isPending ? 'Creating…' : 'Connect Sentry'}
          </Button>
        ) : (
          <div className="space-y-3 rounded-lg border border-th-border bg-th-inset p-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-th-text-4">Inbound URL</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-th-surface px-2 py-1 text-xs text-th-text-2">{inboundUrl}</code>
                <Button onClick={() => inboundUrl && void copy(inboundUrl, 'Inbound URL')} size="sm" type="button" variant="outline"><Copy className="h-3 w-3" />Copy</Button>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-th-text-4">HMAC secret</div>
              {secret ? (
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-th-surface px-2 py-1 text-xs text-th-text-2">{secret}</code>
                  <Button onClick={() => void copy(secret, 'HMAC secret')} size="sm" type="button" variant="outline"><Copy className="h-3 w-3" />Copy once</Button>
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between gap-3 text-sm text-th-text-3">
                  <span>The secret was shown only when created. Rotate it if you need a new copy.</span>
                  <Button disabled={rotateMutation.isPending} onClick={() => void rotateMutation.mutateAsync(source.id)} size="sm" type="button" variant="outline">
                    <RotateCcw className="h-3 w-3" />Rotate secret
                  </Button>
                </div>
              )}
            </div>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-th-text-3">
              <li>In Sentry, create or edit an Internal Integration for your organization.</li>
              <li>Enable webhooks for Issue and Event Alert events.</li>
              <li>Paste the inbound URL and HMAC secret, then save the integration.</li>
            </ol>
          </div>
        )}
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
      toast.success(`${agentSettingLabel(variables.key)} saved.`)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: async (key: string) => { await deleteSetting(key); return key },
    onSuccess: async (key) => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success(`${agentSettingLabel(key)} reset to the default value.`)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
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

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => upsertSetting(key, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success(editingKey === null ? 'Setting saved.' : 'Setting updated.')
      setKeyValue('')
      setSettingValueStr('')
      setEditingKey(null)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: deleteSetting,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Setting deleted.')
      setKeyValue('')
      setSettingValueStr('')
      setEditingKey(null)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
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
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={removeMutation.isPending}
                    onClick={() => void removeMutation.mutateAsync(setting.key)}
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

  const mutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('Password changed successfully.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()

    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters.')
      return
    }

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match.')
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

function GenericWebhookSection() {
  const queryClient = useQueryClient()
  const sourcesQuery = useQuery({ queryKey: ['webhook-sources'], queryFn: listWebhookSources })
  const [name, setName] = useState('Generic webhook')
  const [externalIdPath, setExternalIdPath] = useState('$.event.id')
  const [signatureHeader, setSignatureHeader] = useState('X-Webhook-Signature')
  const [signatureAlgorithm, setSignatureAlgorithm] = useState<'sha256' | 'sha1'>('sha256')
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null)

  const createMutation = useMutation({
    mutationFn: () =>
      createWebhookSource({
        kind: 'generic',
        name,
        enabled: true,
        config: {
          external_id_path: externalIdPath,
          signature_header: signatureHeader,
          signature_algorithm: signatureAlgorithm,
        },
      }),
    onSuccess: async ({ webhook_source }) => {
      await queryClient.invalidateQueries({ queryKey: ['webhook-sources'] })
      setCreated({ url: webhook_source.webhook_url, secret: webhook_source.secret ?? '' })
      toast.success('Generic webhook source created.')
    },
    onError: (err) => toast.error(formatQueryError(err)),
  })

  const sources = (sourcesQuery.data?.webhook_sources ?? []).filter((s) => s.kind === 'generic')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-th-text-3" />
          <CardTitle>Generic webhooks</CardTitle>
          <Badge variant={sources.length > 0 ? 'running' : 'secondary'}>
            {sources.length > 0 ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'Not set'}
          </Badge>
        </div>
        <CardDescription>
          Create an HMAC-signed JSON webhook source for systems that do not have a first-class adapter.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sourcesQuery.isError ? <ErrorPanel detail={formatQueryError(sourcesQuery.error)} title="Sources unavailable" /> : null}
        {created ? (
          <div className="space-y-2 rounded-lg border border-th-success/30 bg-th-success-muted p-3 text-sm">
            <p className="font-medium text-th-success">Save this secret now — it is shown once.</p>
            <code className="block break-all text-th-text-2">URL: {created.url}</code>
            <code className="block break-all text-th-text-2">Secret: {created.secret}</code>
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="External ID JSONPath">
            <Input value={externalIdPath} onChange={(e) => setExternalIdPath(e.target.value)} placeholder="$.event.id" />
          </Field>
          <Field label="Signature header">
            <Input value={signatureHeader} onChange={(e) => setSignatureHeader(e.target.value)} placeholder="X-Webhook-Signature" />
          </Field>
          <Field label="Algorithm">
            <Select value={signatureAlgorithm} onValueChange={(v) => setSignatureAlgorithm(v as 'sha256' | 'sha1')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sha256">sha256</SelectItem>
                <SelectItem value="sha1">sha1</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button disabled={createMutation.isPending || !name.trim()} onClick={() => createMutation.mutate()} type="button">
          {createMutation.isPending ? 'Creating…' : 'Create source'}
        </Button>
        {sources.length > 0 ? (
          <div className="space-y-2">
            {sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-th-border bg-th-inset p-3 text-sm">
                <div className="font-medium text-th-text-1">{source.name}</div>
                <code className="break-all text-xs text-th-text-3">{source.webhook_url}</code>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ProxySection() {
  const queryClient = useQueryClient()
  const proxyQuery = useQuery({ queryKey: ['proxy-status'], queryFn: getProxyStatus })

  const proxyEnabled = proxyQuery.data?.enabled ?? true

  const [pingResult, setPingResult] = useState<ProxyPingResult | null>(null)

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await upsertSetting('proxy.enabled', enabled ? 'true' : 'false')
    },
    onSuccess: async (_result, enabled) => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await queryClient.invalidateQueries({ queryKey: ['proxy-status'] })
      toast.success(enabled ? 'Proxy enabled.' : 'Proxy disabled.')
      setPingResult(null)
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const pingMutation = useMutation({
    mutationFn: proxyPing,
    onSuccess: (data) => {
      setPingResult(data)
    },
    onError: (error: unknown) => {
      toast.error(formatQueryError(error))
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
        <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-th-border bg-th-surface px-3 py-2">
          <Switch
            aria-label={proxyEnabled ? 'Disable proxy' : 'Enable proxy'}
            checked={proxyEnabled}
            disabled={toggleMutation.isPending}
            onCheckedChange={(enabled) => {
              setPingResult(null)
              void toggleMutation.mutateAsync(enabled)
            }}
          />
          <span className="text-sm text-th-text-2">
            {proxyEnabled ? 'Proxy enabled' : 'Proxy disabled'}
          </span>
        </div>
        <Button
          disabled={pingMutation.isPending}
          onClick={() => {
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

  const prevExisting = useRef(existing?.value)
  if (existing?.value !== prevExisting.current) {
    prevExisting.current = existing?.value
    if (existing) setDomain(existing.value)
  }

  const saveMutation = useMutation({
    mutationFn: (value: string) => upsertSetting('domain', value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Domain saved.')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSetting('domain'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Domain removed.')
      setDomain('')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
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
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
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
                onClick={() => void removeMutation.mutateAsync()}
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

// ── API tokens ─────────────────────────────────────────────────────
//
// Mint tokens for the MCP transport and any other bearer caller of
// /api/v1. The dashboard cookie session already grants admin scope so
// this section is accessible to any signed-in user; revisit if/when
// per-user roles land.

const SCOPE_OPTIONS: { value: ApiTokenScope; label: string; description: string }[] = [
  { value: 'read', label: 'read', description: 'List + get on every resource.' },
  {
    value: 'write',
    label: 'write',
    description: 'Mutations on workflows, triggers, projects, settings.',
  },
  {
    value: 'admin',
    label: 'admin',
    description: 'Issue + revoke other tokens. Implies read + write everywhere.',
  },
]

function formatTimestamp(unixSeconds: number | null): string {
  if (unixSeconds === null) return 'never'
  const ms = unixSeconds * 1000
  const date = new Date(ms)
  const diff = Date.now() - ms
  const oneDay = 24 * 60 * 60 * 1000
  if (diff < 60 * 1000) return 'just now'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < oneDay) return `${Math.floor(diff / (60 * 60 * 1000))}h ago`
  if (diff < 30 * oneDay) return `${Math.floor(diff / oneDay)}d ago`
  return date.toLocaleDateString()
}

function ApiTokensSection() {
  const queryClient = useQueryClient()
  const tokensQuery = useQuery({
    queryKey: ['api-tokens'],
    queryFn: listApiTokens,
  })

  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<ApiTokenScope>>(
    () => new Set<ApiTokenScope>(['read', 'write']),
  )
  const [issuedToken, setIssuedToken] = useState<ApiTokenWithPlaintext | null>(null)

  const createMutation = useMutation({
    mutationFn: () =>
      createApiToken(name.trim(), [...scopes] as ApiTokenScope[]),
    onSuccess: async ({ token }) => {
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] })
      setIssuedToken(token)
      setName('')
      setScopes(new Set<ApiTokenScope>(['read', 'write']))
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => deleteApiToken(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] })
      toast.success('Token revoked.')
    },
    onError: (error: unknown) => toast.error(formatQueryError(error)),
  })

  const toggleScope = (scope: ApiTokenScope) => {
    setScopes((current) => {
      const next = new Set(current)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim().length === 0) {
      toast.error('Name is required.')
      return
    }
    if (scopes.size === 0) {
      toast.error('At least one scope is required.')
      return
    }
    void createMutation.mutateAsync()
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-th-text-3" />
            <CardTitle>API tokens</CardTitle>
          </div>
          <CardDescription>
            Bearer tokens for <code className="rounded bg-th-inset px-1.5 py-0.5 text-[12px]">/api/v1/*</code> and the MCP transport at{' '}
            <code className="rounded bg-th-inset px-1.5 py-0.5 text-[12px]">/mcp</code>.
            Plaintext is only shown once at creation — store it now or revoke and reissue.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Name">
              <Input
                onChange={(event) => setName(event.target.value)}
                placeholder="claude-desktop-mcp"
                value={name}
              />
            </Field>

            <Field label="Scopes">
              <div className="space-y-2">
                {SCOPE_OPTIONS.map((option) => {
                  const checked = scopes.has(option.value)
                  return (
                    <label
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-th-border bg-th-surface px-3 py-2.5 transition-colors hover:bg-th-muted"
                      key={option.value}
                    >
                      <Checkbox
                        checked={checked}
                        className="mt-0.5"
                        onCheckedChange={() => toggleScope(option.value)}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-th-text-1">
                          {option.label}
                        </div>
                        <div className="text-xs text-th-text-3">{option.description}</div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </Field>

            <Button
              disabled={createMutation.isPending || name.trim().length === 0 || scopes.size === 0}
              type="submit"
              variant="secondary"
            >
              {createMutation.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {tokensQuery.isPending ? <LoadingPanel title="Loading tokens" compact /> : null}
      {tokensQuery.isError ? (
        <ErrorPanel
          detail={formatQueryError(tokensQuery.error)}
          title="Could not list tokens"
        />
      ) : null}

      {tokensQuery.data && tokensQuery.data.tokens.length > 0 ? (
        <Card className="gap-0 p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3 sm:px-6">
            <CardTitle className="text-sm">Existing tokens</CardTitle>
          </div>
          <div className="divide-y divide-th-border">
            {tokensQuery.data.tokens.map((token) => (
              <ApiTokenRow
                key={token.id}
                token={token}
                onRevoke={() => void revokeMutation.mutateAsync(token.id)}
                revoking={revokeMutation.isPending}
              />
            ))}
          </div>
        </Card>
      ) : tokensQuery.data && !tokensQuery.isPending ? (
        <EmptyState
          title="No tokens yet"
          description="Create one above to authenticate the MCP transport or any /api/v1 caller."
        />
      ) : null}

      <IssuedTokenDialog
        token={issuedToken}
        onClose={() => setIssuedToken(null)}
      />
    </div>
  )
}

function ApiTokenRow({
  token,
  onRevoke,
  revoking,
}: {
  token: ApiToken
  onRevoke: () => void
  revoking: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-th-text-1">{token.name}</span>
          {token.scopes.map((scope) => (
            <Badge key={scope} variant="secondary">
              {scope}
            </Badge>
          ))}
        </div>
        <div className="text-xs text-th-text-3">
          created {formatTimestamp(token.created_at)} · last used {formatTimestamp(token.last_used_at)}
        </div>
      </div>
      <Button
        aria-label="Revoke token"
        disabled={revoking}
        onClick={onRevoke}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Trash2 className="h-3.5 w-3.5 text-th-danger" />
      </Button>
    </div>
  )
}

function IssuedTokenDialog({
  token,
  onClose,
}: {
  token: ApiTokenWithPlaintext | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  // Reset copied state when a fresh token rolls in. Using the
  // prev-ref pattern instead of useEffect so we don't trip the
  // "no setState in useEffect" lint rule.
  const prevTokenId = useRef(token?.id ?? null)
  if (token?.id !== prevTokenId.current) {
    prevTokenId.current = token?.id ?? null
    if (copied) setCopied(false)
  }

  const copy = async () => {
    if (!token) return
    try {
      await navigator.clipboard.writeText(token.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (insecure context or denied) —
      // the textarea below is selectable so the user can copy manually.
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token created</DialogTitle>
          <DialogDescription>
            Copy this now — it will never be shown again. If you lose it, revoke
            and create a new one.
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <div className="space-y-3">
            <div className="flex items-stretch gap-2">
              <code className="flex-1 break-all rounded-lg border border-th-border bg-th-inset px-3 py-2.5 font-mono text-xs text-th-text-1">
                {token.plaintext}
              </code>
              <Button onClick={copy} type="button" variant="secondary">
                {copied ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div className="text-xs text-th-text-3">
              Use as{' '}
              <code className="rounded bg-th-inset px-1 py-0.5">
                Authorization: Bearer {'<token>'}
              </code>{' '}
              against <code className="rounded bg-th-inset px-1 py-0.5">/api/v1/*</code>{' '}
              or POST <code className="rounded bg-th-inset px-1 py-0.5">/mcp</code>.
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={onClose} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
