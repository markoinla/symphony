import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  Key,
  Radio,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  createWebhookSource,
  deleteSetting,
  getIntegrations,
  getSettings,
  listWebhookSources,
  revokeOAuth,
  updateWebhookSource,
  upsertSetting,
} from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { ErrorPanel, LoadingPanel } from '@/components/feedback'
import { Field } from '@/components/field'
import { formatQueryError } from '@/lib/helpers'

function absoluteInboundUrl(path: string): string {
  if (path.startsWith('http')) return path
  return `${window.location.origin}${path}`
}

export function IntegrationsView() {
  const integrationsQuery = useQuery({ queryKey: ['integrations'], queryFn: getIntegrations })
  const sourcesQuery = useQuery({ queryKey: ['webhook-sources'], queryFn: listWebhookSources })

  if (integrationsQuery.isPending || sourcesQuery.isPending) {
    return <LoadingPanel title="Loading integrations" />
  }
  if (integrationsQuery.isError) {
    return (
      <ErrorPanel detail={formatQueryError(integrationsQuery.error)} title="Integrations unavailable" />
    )
  }
  if (sourcesQuery.isError) {
    return (
      <ErrorPanel detail={formatQueryError(sourcesQuery.error)} title="Webhook sources unavailable" />
    )
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-th-text-4">Integrations</p>
        <h1 className="text-3xl font-semibold text-th-text">Connected services</h1>
        <p className="mt-2 text-sm text-th-text-3">
          Connect source systems and register inbound webhook URLs for workflow triggers.
        </p>
      </div>

      <LinearApiKeySection />
      <LinearOAuthSection />
      <GitHubSection />
      <SentryWebhookSection />
      <GenericWebhookSection />
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
    ? existing.value.slice(0, 8) + '•'.repeat(Math.max(0, existing.value.length - 8))
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

function GitHubSection() {
  const queryClient = useQueryClient()

  const integrationsQuery = useQuery({
    queryKey: ['integrations'],
    queryFn: getIntegrations,
    refetchInterval: 60_000,
  })
  const sourcesQuery = useQuery({ queryKey: ['webhook-sources'], queryFn: listWebhookSources })

  const githubSource = sourcesQuery.data?.webhook_sources.find((s) => s.kind === 'github') ?? null

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

  const createSourceMutation = useMutation({
    mutationFn: () => createWebhookSource({ kind: 'github', name: 'GitHub' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['webhook-sources'] })
      const url = absoluteInboundUrl(data.webhook_source.inbound_url)
      toast.success('GitHub webhook source registered. Copy the secret now — it will not be shown again.')
      void navigator.clipboard?.writeText(`URL: ${url}\nSecret: ${data.webhook_source.secret ?? ''}`)
    },
  })

  const inboundUrl = githubSource ? absoluteInboundUrl(githubSource.inbound_url) : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-th-text-3" />
          <CardTitle>GitHub</CardTitle>
          <Badge variant={connected ? 'running' : 'secondary'}>
            {connected ? 'Installed' : 'Not installed'}
          </Badge>
        </div>
        <CardDescription>
          Install the GitHub App so the agent can push branches and open PRs, then register a signed
          webhook source so GitHub events trigger workflows.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-lg border border-th-border bg-th-inset p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-th-text-2">
              {connected ? (
                <div>
                  Installed on <span className="text-th-text-1">{repoLabel}</span>
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
                onClick={() => {
                  window.location.href = '/github/install'
                }}
                size={connected ? 'sm' : 'default'}
                type="button"
                variant={connected ? 'secondary' : 'default'}
              >
                {connected ? 'Reconfigure' : 'Install GitHub App'}
              </Button>
            </div>
          </div>
        </div>

        {!githubSource ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-th-border bg-th-surface p-4">
            <div className="text-sm text-th-text-3">
              Register a webhook source to receive PR, issue, and check_run events from GitHub.
            </div>
            <Button
              disabled={createSourceMutation.isPending}
              onClick={() => createSourceMutation.mutate()}
              type="button"
              variant="outline"
            >
              {createSourceMutation.isPending ? 'Registering…' : 'Register webhook source'}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-th-border bg-th-surface-subtle p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-th-text-4">Inbound webhook URL</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded bg-th-surface px-2 py-1 text-xs text-th-text">
                {inboundUrl}
              </code>
              <Button
                onClick={() => {
                  if (!inboundUrl) return
                  void navigator.clipboard?.writeText(inboundUrl)
                  toast.success('Inbound URL copied')
                }}
                size="icon-sm"
                type="button"
                variant="outline"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="mt-2 text-xs text-th-text-4">
              HMAC secrets are copy-once. Rotate or create a new source if the secret is lost.
            </p>
          </div>
        )}
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
          {source ? (
            <Badge variant={source.enabled ? 'running' : 'secondary'}>
              {source.enabled ? 'Connected' : 'Disabled'}
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>
        <CardDescription>
          Create an inbound URL and HMAC secret for a Sentry internal integration. Paste these values into
          Sentry's webhook URL and secret fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!source ? (
          <Button
            disabled={createMutation.isPending}
            onClick={() => void createMutation.mutateAsync()}
            type="button"
          >
            {createMutation.isPending ? 'Creating…' : 'Connect Sentry'}
          </Button>
        ) : (
          <div className="space-y-3 rounded-lg border border-th-border bg-th-inset p-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-th-text-4">Inbound URL</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-th-surface px-2 py-1 text-xs text-th-text-2">
                  {inboundUrl}
                </code>
                <Button
                  onClick={() => inboundUrl && void copy(inboundUrl, 'Inbound URL')}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Copy className="h-3 w-3" />
                  Copy
                </Button>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-th-text-4">HMAC secret</div>
              {secret ? (
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-th-surface px-2 py-1 text-xs text-th-text-2">
                    {secret}
                  </code>
                  <Button
                    onClick={() => void copy(secret, 'HMAC secret')}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Copy className="h-3 w-3" />
                    Copy once
                  </Button>
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between gap-3 text-sm text-th-text-3">
                  <span>The secret was shown only when created. Rotate it if you need a new copy.</span>
                  <Button
                    disabled={rotateMutation.isPending}
                    onClick={() => void rotateMutation.mutateAsync(source.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Rotate secret
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
        {sourcesQuery.isError ? (
          <ErrorPanel detail={formatQueryError(sourcesQuery.error)} title="Sources unavailable" />
        ) : null}
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
            <Input
              value={externalIdPath}
              onChange={(e) => setExternalIdPath(e.target.value)}
              placeholder="$.event.id"
            />
          </Field>
          <Field label="Signature header">
            <Input
              value={signatureHeader}
              onChange={(e) => setSignatureHeader(e.target.value)}
              placeholder="X-Webhook-Signature"
            />
          </Field>
          <Field label="Algorithm">
            <Select
              value={signatureAlgorithm}
              onValueChange={(v) => setSignatureAlgorithm(v as 'sha256' | 'sha1')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sha256">sha256</SelectItem>
                <SelectItem value="sha1">sha1</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button
          disabled={createMutation.isPending || !name.trim()}
          onClick={() => createMutation.mutate()}
          type="button"
        >
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
