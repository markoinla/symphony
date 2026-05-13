import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
import {
  ErrorPanel,
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
import { newTriggerDraft } from '@/lib/api/workflow-types'
import { getSettings } from '../../lib/api'
import type {
  McpServer,
  Trigger,
  Workflow,
  WorkflowUpdateBody,
} from '@/lib/api/workflow-types'
import { formatQueryError } from '@/lib/helpers'

import { TriggerRow } from './trigger-row'
import { PromptEditor } from './prompt-editor'

// MVP — the Tools & sandbox tab is hidden because the fields it
// surfaced (allowed_tools, mcp_servers, hooks, permission_mode,
// allowed_domains, additional_*_paths) aren't yet plumbed through to
// the sandbox-dispatcher / pi engine. The columns are still in D1
// and round-trip through the API, but the editor doesn't pretend they
// do something they don't. Re-enable the tab + the ToolsTab/
// McpServerEditor components once those fields are wired (Layer 2 of
// the SYM-295 follow-up plan — sandbox-dispatcher /run schema +
// engine adapter changes).

// Editor-local working copy of a workflow. We normalize all nullable
// string fields to empty strings and nullable arrays to [] so form
// controls don't have to special-case null. `draftToBody` converts
// back when we PUT to the API.
type Draft = {
  name: string
  description: string
  engine: string
  model: string
  max_turns: number
  max_continuations: number
  allowed_tools: string[]
  disallowed_tools: string[]
  allowed_domains: string[]
  mcp_servers: McpServer[]
  permission_mode: string
  additional_read_paths: string[]
  additional_write_paths: string[]
  hook_after_create: string
  hook_before_remove: string
  hook_timeout_ms: number
  prompt_template: string
}

function workflowToDraft(workflow: Workflow): Draft {
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    engine: workflow.engine,
    model: workflow.model ?? '',
    max_turns: workflow.max_turns,
    max_continuations: workflow.max_continuations ?? 0,
    allowed_tools: workflow.allowed_tools ?? [],
    disallowed_tools: workflow.disallowed_tools ?? [],
    allowed_domains: workflow.allowed_domains ?? [],
    mcp_servers: workflow.mcp_servers ?? [],
    permission_mode: workflow.permission_mode ?? 'ask',
    additional_read_paths: workflow.additional_read_paths ?? [],
    additional_write_paths: workflow.additional_write_paths ?? [],
    hook_after_create: workflow.hook_after_create ?? '',
    hook_before_remove: workflow.hook_before_remove ?? '',
    hook_timeout_ms: workflow.hook_timeout_ms,
    prompt_template: workflow.prompt_template,
  }
}

function draftToBody(draft: Draft): WorkflowUpdateBody {
  // Trim free-form strings, coerce empty strings to null on
  // nullable backend fields so the column doesn't store `""`.
  const nullable = (s: string) => {
    const trimmed = s.trim()
    return trimmed === '' ? null : trimmed
  }
  return {
    name: draft.name,
    description: nullable(draft.description),
    engine: draft.engine,
    model: nullable(draft.model),
    max_turns: draft.max_turns,
    max_continuations: draft.max_continuations,
    allowed_tools: draft.allowed_tools,
    disallowed_tools: draft.disallowed_tools,
    allowed_domains: draft.allowed_domains,
    mcp_servers: draft.mcp_servers,
    permission_mode: nullable(draft.permission_mode),
    additional_read_paths: draft.additional_read_paths,
    additional_write_paths: draft.additional_write_paths,
    hook_after_create: nullable(draft.hook_after_create),
    hook_before_remove: nullable(draft.hook_before_remove),
    hook_timeout_ms: draft.hook_timeout_ms,
    prompt_template: draft.prompt_template,
  }
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

  // Org defaults so the Model input's placeholder can show what the
  // workflow would inherit if left blank. A failure here just falls
  // back to a static placeholder — never block the editor.
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const orgDefaultModel = useMemo(() => {
    const data = settingsQuery.data
    if (!data) return null
    const override = data.settings.find((s) => s.key === 'agent.default_model')
    return override?.value ?? data.agent_defaults.default_model ?? null
  }, [settingsQuery.data])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [triggerDrafts, setTriggerDrafts] = useState<Record<string, Trigger>>(
    {},
  )
  // Reseed the draft when the remote workflow's updated_at changes (a
  // save or refetch). Until then, user edits live in `draft`.
  const [seededFromUpdatedAt, setSeededFromUpdatedAt] = useState<number | null>(
    null,
  )
  const [seededTriggersKey, setSeededTriggersKey] = useState<string | null>(
    null,
  )

  if (
    workflowQuery.data &&
    workflowQuery.data.updated_at !== seededFromUpdatedAt
  ) {
    setSeededFromUpdatedAt(workflowQuery.data.updated_at)
    setDraft(workflowToDraft(workflowQuery.data))
  }

  const triggersKey = triggersQuery.data
    ? triggersQuery.data.map((t) => `${t.id}:${t.updated_at}`).join('|')
    : null
  if (triggersKey && triggersKey !== seededTriggersKey) {
    setSeededTriggersKey(triggersKey)
    setTriggerDrafts((current) => {
      const next: Record<string, Trigger> = {}
      for (const trigger of triggersQuery.data ?? []) {
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

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  function handleSave() {
    if (!draft) return
    updateWorkflow.mutate(draftToBody(draft), {
      onSuccess: () => toast.success('Workflow saved.'),
      onError: (err) => toast.error(formatQueryError(err)),
    })
  }

  function handlePublish() {
    publish.mutate(undefined, {
      onSuccess: () => toast.success('Workflow published.'),
      onError: (err) => toast.error(formatQueryError(err)),
    })
  }

  function handleDelete() {
    deleteWorkflow.mutate(workflow.id, {
      onSuccess: () => {
        window.location.href = '/dashboard/workflows'
      },
      onError: (err) => toast.error(formatQueryError(err)),
    })
  }

  function handleAddTrigger() {
    createTrigger.mutate(newTriggerDraft(), {
      onError: (err) => toast.error(formatQueryError(err)),
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
    const {
      id: _id,
      workflow_id: _wid,
      created_at: _ca,
      updated_at: _ua,
      ...body
    } = local
    void _id
    void _wid
    void _ca
    void _ua
    updateTrigger.mutate(
      { id: triggerId, body },
      {
        onSuccess: () => toast.success('Trigger saved.'),
        onError: (err) => toast.error(formatQueryError(err)),
      },
    )
  }

  function handleTriggerDelete(triggerId: string) {
    deleteTrigger.mutate(triggerId, {
      onError: (err) => toast.error(formatQueryError(err)),
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
            v{workflow.version} · {workflow.status}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={deleteWorkflow.isPending}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5 text-th-danger" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete &ldquo;{workflow.name}&rdquo; and
                  all its triggers. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} variant="destructive">
                  Delete workflow
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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

      <Tabs defaultValue="basics">
        <TabsList>
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="triggers">Triggers</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
        </TabsList>

        <TabsContent value="basics">
          <BasicsTab
            draft={draft}
            patchDraft={patchDraft}
            orgDefaultModel={orgDefaultModel}
          />
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
            onChange={(prompt_template) => patchDraft({ prompt_template })}
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
  patchDraft,
  orgDefaultModel,
}: {
  draft: Draft
  patchDraft: (patch: Partial<Draft>) => void
  orgDefaultModel: string | null
}) {
  const modelPlaceholder = orgDefaultModel
    ? `inherits ${orgDefaultModel} from org default`
    : 'provider/model-id (e.g. claude-sonnet-4-6)'
  return (
    <div className="grid max-w-3xl gap-5">
      <Field label="Name">
        <Input
          onChange={(event) => patchDraft({ name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field label="Description">
        <Textarea
          onChange={(event) => patchDraft({ description: event.target.value })}
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
            onValueChange={(engine) => patchDraft({ engine })}
            value={draft.engine}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="codex">codex</SelectItem>
              <SelectItem value="claude-code">claude-code</SelectItem>
              <SelectItem value="pi">pi</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Model"
          hint="Leave blank to inherit the org default. Type a value to override."
        >
          <Input
            onChange={(event) => patchDraft({ model: event.target.value })}
            placeholder={modelPlaceholder}
            value={draft.model}
          />
        </Field>
        <Field
          label="Re-prompt budget"
          hint="How many times to re-invoke the engine if it stops short. Default 1 — pi and claude-code self-manage their turn loops internally; raise only when the engine consistently quits with work left."
        >
          <Input
            min={1}
            onChange={(event) =>
              patchDraft({
                max_turns: Number.parseInt(event.target.value, 10) || 1,
              })
            }
            type="number"
            value={String(draft.max_turns)}
          />
        </Field>
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
