import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  useCreateWorkflow,
  useWorkflows,
} from '@/lib/api/workflows'
import {
  workflowScopeLabel,
  workflowTemplates,
  type Workflow,
  type WorkflowTemplate,
} from '@/lib/api/workflow-types'
import { formatQueryError } from '@/lib/helpers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  EmptyState,
  ErrorPanel,
  LoadingPanel,
} from '@/components/feedback'

function ScopePill({ workflow }: { workflow: Workflow }) {
  // Derived from which of organization_id/team_id/user_id is non-null.
  // The DB CHECK guarantees exactly one is set.
  return (
    <span className="inline-flex items-center rounded bg-th-accent-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-th-accent">
      {workflowScopeLabel(workflow)}
    </span>
  )
}

function StatusBadge({ status }: { status: Workflow['status'] }) {
  const isPublished = status === 'published'
  return (
    <span
      className={
        isPublished
          ? 'inline-flex items-center rounded bg-th-success-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-th-success'
          : 'inline-flex items-center rounded bg-th-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-th-text-3'
      }
    >
      {status === 'published'
        ? 'Published'
        : status === 'archived'
          ? 'Archived'
          : 'Draft'}
    </span>
  )
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  return (
    <Link
      to="/workflows/$id"
      params={{ id: workflow.id }}
      className="block rounded-xl border border-th-border bg-th-surface p-4 transition-shadow hover:shadow-sm sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-th-text-1">
              {workflow.name}
            </h3>
            <ScopePill workflow={workflow} />
            <StatusBadge status={workflow.status} />
          </div>
          {workflow.description ? (
            <p className="text-[13px] text-th-text-3">{workflow.description}</p>
          ) : (
            <p className="text-[13px] text-th-text-4">No description</p>
          )}
          <p className="text-[11px] text-th-text-4">
            {workflow.engine} · {workflow.model ?? 'default model'} · max{' '}
            {workflow.max_turns} turns · v{workflow.version}
          </p>
        </div>
      </div>
    </Link>
  )
}

function TemplateGalleryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const create = useCreateWorkflow({
    onSuccess: (wf) => {
      onCreated(wf.id)
    },
  })

  function handlePick(template: WorkflowTemplate) {
    create.mutate(template.body, {
      onError: (err) => toast.error(formatQueryError(err)),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Pick a template to start from. You can edit every field after
            creating it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 pt-1">
          {workflowTemplates.map((template) => (
            <Button
              key={template.id}
              className="h-auto justify-start whitespace-normal rounded-lg border border-th-border bg-th-surface p-4 text-left font-normal shadow-none hover:border-th-accent hover:bg-th-surface hover:shadow-sm"
              disabled={create.isPending}
              onClick={() => handlePick(template)}
              type="button"
              variant="outline"
            >
              <span className="grid gap-1">
                <span className="text-sm font-semibold text-th-text-1">
                  {template.name}
                </span>
                <span className="text-[13px] text-th-text-3">
                  {template.description}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function WorkflowsView() {
  const workflowsQuery = useWorkflows()
  const [dialogOpen, setDialogOpen] = useState(false)

  const workflows = workflowsQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">
            Workflows
          </h1>
          <p className="mt-1 text-sm text-th-text-3">
            Configure how the agent reacts to Linear events. Each workflow
            bundles tools, sandbox policy, triggers, and a prompt template.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New workflow
        </Button>
      </div>

      {workflowsQuery.isPending ? (
        <LoadingPanel compact title="Loading workflows" />
      ) : null}
      {workflowsQuery.isError ? (
        <ErrorPanel
          detail={formatQueryError(workflowsQuery.error)}
          title="Workflows unavailable"
        />
      ) : null}

      {workflowsQuery.isSuccess && workflows.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon className="h-5 w-5 text-th-text-4" />}
          title="No workflows yet"
          description='Create your first workflow from a template to start routing Linear events to the agent.'
        />
      ) : null}

      <div className="grid gap-3">
        {workflows.map((workflow) => (
          <WorkflowCard key={workflow.id} workflow={workflow} />
        ))}
      </div>

      <TemplateGalleryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(id) => {
          setDialogOpen(false)
          toast.success(`Workflow created. Edit it at /workflows/${id}.`)
        }}
      />
    </div>
  )
}
