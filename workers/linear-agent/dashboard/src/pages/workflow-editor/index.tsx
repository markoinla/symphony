import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Field } from '@/components/field'
import { ChipInput } from '@/components/chip-input'
import {
  ErrorPanel,
  FeedbackBanner,
  LoadingPanel,
} from '@/components/feedback'
import {
  useCreateTrigger,
  useDeleteTrigger,
  useDeleteWorkflow,
  usePublishWorkflow,
  useTriggers,
  useUpdateTrigger,
  useUpdateWorkflow,
  useWorkflow,
} from '@/lib/api/workflows'
import { emptyTrigger } from '@/lib/api/workflow-types'
import type {
  McpServer,
  PermissionMode,
  Trigger,
  Workflow,
  WorkflowConfig,
} from '@/lib/api/workflow-types'
import { formatQueryError } from '@/lib/helpers'

import { TriggerRow } from './trigger-row'
import { PromptEditor } from './prompt-editor'

type Draft = {
  name: string
  description: string
  config: WorkflowConfig
  prompt_template: string
}

function workflowToDraft(workflow: Workflow): Draft {
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    config: workflow.config,
    prompt_template: workflow.prompt_template,
  }
}

function McpServerEditor({
  servers,
  onChange,
}: {
  servers: McpServer[]
  onChange: (next: McpServer[]) => void
}) {
  function updateAt(idx: number, patch: Partial<McpServer>) {
    onChange(servers.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  function removeAt(idx: number) {
    onChange(servers.filter((_, i) => i !== idx))
  }

  function add() {
    onChange([...servers, { name: '', url: '', kind: 'http' }])
  }

  return (
    <div className="grid gap-3">
      {servers.length === 0 ? (
        <p className="text-xs text-th-text-4">No MCP servers configured.</p>
      ) : null}
      {servers.map((server, idx) => (
        <div
          key={idx}
          className="grid gap-3 rounded-md border border-th-border bg-th-surface p-3 sm:grid-cols-[1fr_2fr_120px_auto]"
        >
          <Input
            onChange={(event) => updateAt(idx, { name: event.target.value })}
            placeholder="name"
            value={server.name}
          />
          <Input
            onChange={(event) => updateAt(idx, { url: event.target.value })}
            placeholder="https://…"
            value={server.url}
          />
          <Select
            value={server.kind}
            onValueChange={(value) =>
              updateAt(idx, { kind: value as McpServer['kind'] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
            </SelectContent>
          </Select>
          <Button
            aria-label="Remove MCP server"
            onClick={() => removeAt(idx)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5 text-th-danger" />
          </Button>
        </div>
      ))}
      <Button onClick={add} size="sm" type="button" variant="outline">
        <Plus className="mr-1 h-3 w-3" />
        Add MCP server
      </Button>
    </div>
  )
}

export function WorkflowEditorView() {
  const { id } = useParams({ from: '/workflows/$id' })
  const workflowQuery = useWorkflow(id)
  const triggersQuery = useTriggers(id)
  const updateWorkflow = useUpdateWorkflow(id)
  const publish = usePublishWorkflow(id)
  const deleteWorkflow = useDeleteWorkflow()
  const createTrigger = useCreateTrigger(id)
  const updateTrigger = useUpdateTrigger(id)
  const deleteTrigger = useDeleteTrigger(id)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [triggerDrafts, setTriggerDrafts] = useState<Record<string, Trigger>>(
    {},
  )
  // Track the last workflow updated_at we seeded the draft from. When
  // the remote workflow changes (refetch / mutation), we reseed; user
  // edits live in `draft` until they hit Save.
  const [seededFromUpdatedAt, setSeededFromUpdatedAt] = useState<string | null>(
    null,
  )
  // Same idea for triggers — reseed local trigger drafts when the
  // remote list changes by any saved row's updated_at, additions, or
  // deletions.
  const [seededTriggersKey, setSeededTriggersKey] = useState<string | null>(
    null,
  )

  // Seed draft from the remote workflow during render (avoids the
  // setState-in-effect cascade pattern). Reseeds whenever the remote
  // workflow's updated_at changes — i.e. after a save / refetch.
  if (
    workflowQuery.data &&
    workflowQuery.data.updated_at !== seededFromUpdatedAt
  ) {
    setSeededFromUpdatedAt(workflowQuery.data.updated_at)
    setDraft(workflowToDraft(workflowQuery.data))
  }

  // Same pattern for triggers — derive a stable key from the trigger
  // list and reseed when it changes.
  const triggersKey = triggersQuery.data
    ? triggersQuery.data
        .map((t) => `${t.id}:${t.updated_at}`)
        .join('|')
    : null
  if (triggersKey && triggersKey !== seededTriggersKey) {
    setSeededTriggersKey(triggersKey)
    setTriggerDrafts((current) => {
      const next: Record<string, Trigger> = {}
      for (const trigger of triggersQuery.data ?? []) {
        // Preserve local edits for rows the user is still editing.
        const local = current[trigger.id]
        next[trigger.id] = local ?? trigger
      }
      return next
    })
  }

  const isDirty = useMemo(() => {
    if (!workflowQuery.data || !draft) return false
    const orig = workflowToDraft(workflowQuery.data)
    return JSON.stringify(orig) !== JSON.stringify(draft)
  }, [workflowQuery.data, draft])

  if (workflowQuery.isPending) {
    return <LoadingPanel title="Loading workflow" />
  }
  if (workflowQuery.isError || !workflowQuery.data) {
    return (
      <ErrorPanel
        detail={formatQueryError(workflowQuery.error)}
        title="Workflow unavailable"
      />
    )
  }
  if (!draft) return <LoadingPanel title="Preparing editor" />

  const workflow = workflowQuery.data

  function patchConfig(patch: Partial<WorkflowConfig>) {
    setDraft((current) =>
      current ? { ...current, config: { ...current.config, ...patch } } : current,
    )
  }

  function handleSave() {
    if (!draft) return
    setError(null)
    updateWorkflow.mutate(
      {
        name: draft.name,
        description: draft.description || null,
        config: draft.config,
        prompt_template: draft.prompt_template,
      },
      {
        onSuccess: () => setFeedback('Workflow saved.'),
        onError: (err) => setError(formatQueryError(err)),
      },
    )
  }

  function handlePublish() {
    setError(null)
    publish.mutate(undefined, {
      onSuccess: () => setFeedback('Workflow published.'),
      onError: (err) => setError(formatQueryError(err)),
    })
  }

  function handleDelete() {
    if (!confirm(`Delete workflow "${workflow.name}"? This cannot be undone.`))
      return
    deleteWorkflow.mutate(workflow.id, {
      onSuccess: () => {
        window.location.href = '/dashboard/workflows'
      },
      onError: (err) => setError(formatQueryError(err)),
    })
  }

  function handleAddTrigger() {
    createTrigger.mutate(emptyTrigger(id), {
      onError: (err) => setError(formatQueryError(err)),
    })
  }

  function handleTriggerChange(triggerId: string, patch: Partial<Trigger>) {
    setTriggerDrafts((current) => ({
      ...current,
      [triggerId]: { ...current[triggerId], ...patch },
    }))
  }

  function isTriggerDirty(triggerId: string) {
    const remote = triggersQuery.data?.find((t) => t.id === triggerId)
    const local = triggerDrafts[triggerId]
    if (!remote || !local) return false
    return JSON.stringify(remote) !== JSON.stringify(local)
  }

  function handleTriggerSave(triggerId: string) {
    const local = triggerDrafts[triggerId]
    if (!local) return
    const { id: _id, created_at: _ca, updated_at: _ua, ...body } = local
    void _id
    void _ca
    void _ua
    updateTrigger.mutate(
      { id: triggerId, body },
      {
        onSuccess: () => setFeedback('Trigger saved.'),
        onError: (err) => setError(formatQueryError(err)),
      },
    )
  }

  function handleTriggerDelete(triggerId: string) {
    if (!confirm('Delete this trigger?')) return
    deleteTrigger.mutate(triggerId, {
      onError: (err) => setError(formatQueryError(err)),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/workflows"
            className="inline-flex items-center gap-1 text-xs text-th-text-3 hover:text-th-text-1"
          >
            <ArrowLeft className="h-3 w-3" />
            All workflows
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-th-text-1">
            {draft.name || 'Untitled workflow'}
          </h1>
          <p className="mt-1 text-xs text-th-text-4">
            v{workflow.current_version} · {workflow.status}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            disabled={deleteWorkflow.isPending}
            onClick={handleDelete}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5 text-th-danger" />
            Delete
          </Button>
          <Button
            disabled={publish.isPending}
            onClick={handlePublish}
            size="sm"
            type="button"
            variant="outline"
          >
            Publish
          </Button>
          <Button
            disabled={!isDirty || updateWorkflow.isPending}
            onClick={handleSave}
            type="button"
          >
            {updateWorkflow.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      {feedback ? <FeedbackBanner message={feedback} variant="success" /> : null}
      {error ? <FeedbackBanner message={error} variant="error" /> : null}

      <Tabs defaultValue="basics">
        <TabsList>
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="tools">Tools & sandbox</TabsTrigger>
          <TabsTrigger value="triggers">Triggers</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
        </TabsList>

        <TabsContent value="basics">
          <BasicsTab draft={draft} setDraft={setDraft} />
        </TabsContent>

        <TabsContent value="tools">
          <ToolsTab config={draft.config} patchConfig={patchConfig} />
        </TabsContent>

        <TabsContent value="triggers">
          <TriggersTab
            triggersQuery={triggersQuery}
            triggerDrafts={triggerDrafts}
            onAdd={handleAddTrigger}
            onChange={handleTriggerChange}
            onDelete={handleTriggerDelete}
            onSave={handleTriggerSave}
            isTriggerDirty={isTriggerDirty}
            savingTriggerId={
              updateTrigger.isPending ? updateTrigger.variables?.id : null
            }
          />
        </TabsContent>

        <TabsContent value="prompt">
          <PromptEditor
            onChange={(prompt_template) =>
              setDraft((current) =>
                current ? { ...current, prompt_template } : current,
              )
            }
            value={draft.prompt_template}
            workflowId={id}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BasicsTab({
  draft,
  setDraft,
}: {
  draft: Draft
  setDraft: (next: Draft | ((current: Draft | null) => Draft | null)) => void
}) {
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }
  function patchConfig(patch: Partial<WorkflowConfig>) {
    setDraft((current) =>
      current ? { ...current, config: { ...current.config, ...patch } } : current,
    )
  }
  return (
    <div className="grid max-w-3xl gap-5">
      <Field label="Name">
        <Input
          onChange={(event) => update('name', event.target.value)}
          value={draft.name}
        />
      </Field>
      <Field label="Description">
        <Textarea
          onChange={(event) => update('description', event.target.value)}
          placeholder="What does this workflow do?"
          value={draft.description}
        />
      </Field>
      <Field
        label="Scope"
        hint="Team and User scopes are coming soon — workflows are organization-wide for now."
      >
        <Select disabled value="organization">
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="organization">Organization</SelectItem>
            <SelectItem disabled value="team">
              Team (coming soon)
            </SelectItem>
            <SelectItem disabled value="user">
              User (coming soon)
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Engine">
          <Select
            onValueChange={(engine) => patchConfig({ engine })}
            value={draft.config.engine}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="codex">codex</SelectItem>
              <SelectItem value="claude-code">claude-code</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model">
          <Input
            onChange={(event) => patchConfig({ model: event.target.value })}
            placeholder="claude-sonnet-4-6"
            value={draft.config.model}
          />
        </Field>
        <Field label="Max turns">
          <Input
            min={1}
            onChange={(event) =>
              patchConfig({
                max_turns: Number.parseInt(event.target.value, 10) || 1,
              })
            }
            type="number"
            value={String(draft.config.max_turns)}
          />
        </Field>
        <Field label="Max continuations">
          <Input
            min={0}
            onChange={(event) =>
              patchConfig({
                max_continuations: Number.parseInt(event.target.value, 10) || 0,
              })
            }
            type="number"
            value={String(draft.config.max_continuations)}
          />
        </Field>
      </div>
    </div>
  )
}

function ToolsTab({
  config,
  patchConfig,
}: {
  config: WorkflowConfig
  patchConfig: (patch: Partial<WorkflowConfig>) => void
}) {
  return (
    <div className="grid max-w-3xl gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Allowed tools">
          <ChipInput
            monospace
            onChange={(allowed_tools) => patchConfig({ allowed_tools })}
            placeholder="bash, edit, read…"
            value={config.allowed_tools}
          />
        </Field>
        <Field label="Disallowed tools">
          <ChipInput
            monospace
            onChange={(disallowed_tools) => patchConfig({ disallowed_tools })}
            placeholder="rm -rf …"
            value={config.disallowed_tools}
          />
        </Field>
      </div>

      <Field label="Permission mode">
        <Select
          onValueChange={(value) =>
            patchConfig({ permission_mode: value as PermissionMode })
          }
          value={config.permission_mode}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">ask</SelectItem>
            <SelectItem value="auto">auto</SelectItem>
            <SelectItem value="danger">danger</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Allowed domains" hint="Host allow-list for outbound HTTP.">
        <ChipInput
          monospace
          onChange={(allowed_domains) => patchConfig({ allowed_domains })}
          placeholder="github.com"
          value={config.allowed_domains}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Additional read paths">
          <ChipInput
            monospace
            onChange={(additional_read_paths) =>
              patchConfig({ additional_read_paths })
            }
            placeholder="/etc/config"
            value={config.additional_read_paths}
          />
        </Field>
        <Field label="Additional write paths">
          <ChipInput
            monospace
            onChange={(additional_write_paths) =>
              patchConfig({ additional_write_paths })
            }
            placeholder="/tmp/scratch"
            value={config.additional_write_paths}
          />
        </Field>
      </div>

      <Field label="Hook: after create" hint="Shell run right after workspace creation.">
        <Textarea
          className="font-mono"
          onChange={(event) =>
            patchConfig({ hook_after_create: event.target.value || null })
          }
          placeholder="bun install"
          rows={4}
          value={config.hook_after_create ?? ''}
        />
      </Field>

      <Field label="Hook: before remove" hint="Cleanup before the workspace is torn down.">
        <Textarea
          className="font-mono"
          onChange={(event) =>
            patchConfig({ hook_before_remove: event.target.value || null })
          }
          placeholder="rm -rf node_modules"
          rows={4}
          value={config.hook_before_remove ?? ''}
        />
      </Field>

      <Field label="Hook timeout (ms)">
        <Input
          min={1000}
          onChange={(event) =>
            patchConfig({
              hook_timeout_ms: Number.parseInt(event.target.value, 10) || 30_000,
            })
          }
          type="number"
          value={String(config.hook_timeout_ms)}
        />
      </Field>

      <div>
        <Field
          label="MCP servers"
          hint="Model Context Protocol endpoints the agent can call."
        >
          <span />
        </Field>
        <McpServerEditor
          onChange={(mcp_servers) => patchConfig({ mcp_servers })}
          servers={config.mcp_servers}
        />
      </div>
    </div>
  )
}

function TriggersTab({
  triggersQuery,
  triggerDrafts,
  onAdd,
  onChange,
  onDelete,
  onSave,
  isTriggerDirty,
  savingTriggerId,
}: {
  triggersQuery: ReturnType<typeof useTriggers>
  triggerDrafts: Record<string, Trigger>
  onAdd: () => void
  onChange: (id: string, patch: Partial<Trigger>) => void
  onDelete: (id: string) => void
  onSave: (id: string) => void
  isTriggerDirty: (id: string) => boolean
  savingTriggerId: string | null | undefined
}) {
  if (triggersQuery.isPending) {
    return <LoadingPanel compact title="Loading triggers" />
  }
  if (triggersQuery.isError) {
    return (
      <ErrorPanel
        detail={formatQueryError(triggersQuery.error)}
        title="Triggers unavailable"
      />
    )
  }
  const triggers = triggersQuery.data ?? []
  return (
    <div className="grid gap-4">
      {triggers.length === 0 ? (
        <p className="text-sm text-th-text-4">
          No triggers yet. Add one to start matching Linear events.
        </p>
      ) : null}
      {triggers.map((trigger) => {
        const local = triggerDrafts[trigger.id] ?? trigger
        return (
          <TriggerRow
            isDirty={isTriggerDirty(trigger.id)}
            isSaving={savingTriggerId === trigger.id}
            key={trigger.id}
            onChange={(patch) => onChange(trigger.id, patch)}
            onDelete={() => onDelete(trigger.id)}
            onSave={() => onSave(trigger.id)}
            trigger={local}
          />
        )
      })}
      <Button onClick={onAdd} type="button" variant="outline">
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add trigger
      </Button>
    </div>
  )
}
