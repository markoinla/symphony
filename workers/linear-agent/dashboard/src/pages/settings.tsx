import { useRef, useState, useEffect, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  Copy,
  KeyRound,
  Lock,
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
  type Setting,
  changePassword,
  createApiToken,
  deleteApiToken,
  deleteSetting,
  getSettings,
  listApiTokens,
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

      <Tabs defaultValue="agent">
        <TabsList>
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
