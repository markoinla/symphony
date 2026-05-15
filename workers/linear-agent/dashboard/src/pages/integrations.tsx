import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

import {
  createWebhookSource,
  getGitHubOAuthAuthorizeUrl,
  getIntegrations,
  listWebhookSources,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LoadingPanel, ErrorPanel, EmptyState } from '@/components/feedback'
import { formatQueryError } from '@/lib/helpers'

function absoluteInboundUrl(path: string): string {
  if (path.startsWith('http')) return path
  return `${window.location.origin}${path}`
}

export function IntegrationsView() {
  const queryClient = useQueryClient()
  const integrationsQuery = useQuery({ queryKey: ['integrations'], queryFn: getIntegrations })
  const sourcesQuery = useQuery({ queryKey: ['webhook-sources'], queryFn: listWebhookSources })
  const githubSource = sourcesQuery.data?.webhook_sources.find((s) => s.kind === 'github') ?? null

  const createSourceMutation = useMutation({
    mutationFn: () => createWebhookSource({ kind: 'github', name: 'GitHub' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['webhook-sources'] })
      const url = absoluteInboundUrl(data.webhook_source.inbound_url)
      toast.success('GitHub webhook source registered. Copy the secret now — it will not be shown again.')
      void navigator.clipboard?.writeText(`URL: ${url}\nSecret: ${data.webhook_source.secret ?? ''}`)
    },
  })

  const installGitHub = async () => {
    const { authorize_url } = await getGitHubOAuthAuthorizeUrl()
    window.location.href = authorize_url
  }

  if (integrationsQuery.isPending || sourcesQuery.isPending) {
    return <LoadingPanel title="Loading integrations" />
  }
  if (integrationsQuery.isError) {
    return <ErrorPanel detail={formatQueryError(integrationsQuery.error)} title="Integrations unavailable" />
  }
  if (sourcesQuery.isError) {
    return <ErrorPanel detail={formatQueryError(sourcesQuery.error)} title="Webhook sources unavailable" />
  }

  const github = integrationsQuery.data.github
  const inboundUrl = githubSource ? absoluteInboundUrl(githubSource.inbound_url) : null

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-wide text-th-text-4">Integrations</p>
        <h1 className="text-3xl font-semibold text-th-text">Connected services</h1>
        <p className="mt-2 text-sm text-th-text-3">
          Connect source systems and register inbound webhook URLs for workflow triggers.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>GitHub</CardTitle>
              <CardDescription>
                Install the GitHub App for repository access, then register a signed webhook source for PR triggers.
              </CardDescription>
            </div>
            <Badge variant={github.connected ? 'running' : 'secondary'}>
              {github.connected ? 'Connected' : 'Not connected'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={installGitHub} type="button">
              {github.connected ? 'Reconfigure GitHub App' : 'Install GitHub App'}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
            {integrationsQuery.data.github_app_settings_url ? (
              <Button asChild type="button" variant="outline">
                <a href={integrationsQuery.data.github_app_settings_url} rel="noreferrer" target="_blank">
                  Manage in GitHub
                </a>
              </Button>
            ) : null}
            {!githubSource ? (
              <Button
                disabled={createSourceMutation.isPending}
                onClick={() => createSourceMutation.mutate()}
                type="button"
                variant="outline"
              >
                {createSourceMutation.isPending ? 'Registering…' : 'Register webhook source'}
              </Button>
            ) : null}
          </div>

          {githubSource && inboundUrl ? (
            <div className="rounded-lg border border-th-border bg-th-surface-subtle p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-th-text-4">Inbound webhook URL</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded bg-th-surface px-2 py-1 text-xs text-th-text">
                  {inboundUrl}
                </code>
                <Button
                  onClick={() => {
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
          ) : (
            <EmptyState
              title="No GitHub webhook source"
              description="Register a source to get the inbound URL and copy-once HMAC secret for GitHub webhooks."
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
