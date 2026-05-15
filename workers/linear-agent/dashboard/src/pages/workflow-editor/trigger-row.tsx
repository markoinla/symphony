import { Trash2 } from 'lucide-react'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ChipInput } from '@/components/chip-input'
import { Field } from '@/components/field'
import type {
  EventType,
  Trigger,
  TriggerAction,
} from '@/lib/api/workflow-types'

const eventTypeOptions: { value: EventType; label: string }[] = [
  { value: 'api.invoke', label: 'API invoke' },
  { value: 'state_entered', label: 'State entered' },
  { value: 'state_exited', label: 'State exited' },
  { value: 'comment_added', label: 'Comment added' },
  { value: 'label_added', label: 'Label added' },
  { value: 'label_removed', label: 'Label removed' },
  { value: 'assignee_changed', label: 'Assignee changed' },
  { value: 'session_started', label: 'Session started' },
]

const actionOptions: { value: TriggerAction; label: string }[] = [
  { value: 'start_session', label: 'Start session' },
  { value: 'continue_session', label: 'Continue session' },
  { value: 'reset_session', label: 'Reset session' },
  { value: 'stop_session', label: 'Stop session' },
  { value: 'post_comment', label: 'Post comment' },
  { value: 'transition_to', label: 'Transition to' },
]

function expectedSubjectKinds(trigger: Trigger): string {
  if (trigger.expected_subject_kinds?.length) {
    return trigger.expected_subject_kinds.join(', ')
  }
  return trigger.event_type === 'api.invoke' ? 'linear_issue, generic' : 'linear_issue'
}

export function TriggerRow({
  trigger,
  onChange,
  onDelete,
  isDirty,
  isSaving,
  onSave,
}: {
  trigger: Trigger
  onChange: (patch: Partial<Trigger>) => void
  onDelete: () => void
  isDirty: boolean
  isSaving: boolean
  onSave: () => void
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-surface p-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Event">
          <Select
            value={trigger.event_type}
            onValueChange={(value) =>
              onChange({
                event_type: value as EventType,
                // Reset event-specific match columns when the event
                // type changes — keeps stale values from "any-matching"
                // the new event type.
                from_state: null,
                to_state: null,
                label_name: null,
                comment_match: null,
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {eventTypeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Action">
          <Select
            value={trigger.action}
            onValueChange={(value) =>
              onChange({ action: value as TriggerAction })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actionOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="flex items-end gap-1.5">
          <Button
            disabled={!isDirty || isSaving}
            onClick={onSave}
            size="sm"
            type="button"
          >
            {isSaving ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                aria-label="Delete trigger"
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="h-3.5 w-3.5 text-th-danger" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete trigger?</AlertDialogTitle>
                <AlertDialogDescription>
                  This trigger will be removed from the workflow. This cannot be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete} variant="destructive">
                  Delete trigger
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Event-type-specific match fields. The backend only has four
          match columns: to_state, from_state, label_name, comment_match.
          Assignee transitions match via scope filters only. */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <p className="col-span-full text-xs text-th-text-4">
          Expected subject kinds: {expectedSubjectKinds(trigger)}
        </p>

        {(trigger.event_type === 'state_entered' ||
          trigger.event_type === 'state_exited') && (
          <>
            <Field
              label="From state"
              hint="Match only when leaving this state"
            >
              <Input
                onChange={(event) =>
                  onChange({ from_state: event.target.value || null })
                }
                placeholder="In Progress"
                value={trigger.from_state ?? ''}
              />
            </Field>
            <Field label="To state" hint="Match only when entering this state">
              <Input
                onChange={(event) =>
                  onChange({ to_state: event.target.value || null })
                }
                placeholder="Todo"
                value={trigger.to_state ?? ''}
              />
            </Field>
          </>
        )}

        {(trigger.event_type === 'label_added' ||
          trigger.event_type === 'label_removed') && (
          <Field label="Label name">
            <Input
              onChange={(event) =>
                onChange({ label_name: event.target.value || null })
              }
              placeholder="rework"
              value={trigger.label_name ?? ''}
            />
          </Field>
        )}

        {trigger.event_type === 'comment_added' && (
          <Field
            label="Comment match (regex)"
            hint="Anchored regex, e.g. ^/retry\b"
          >
            <Input
              onChange={(event) =>
                onChange({ comment_match: event.target.value || null })
              }
              placeholder="^/retry\b"
              value={trigger.comment_match ?? ''}
            />
          </Field>
        )}

        {trigger.event_type === 'assignee_changed' && (
          <p className="col-span-full text-xs text-th-text-4">
            Assignee transitions match every event; use the assignee filter
            below to scope to specific users.
          </p>
        )}
      </div>

      {/* Scope filters */}
      <div className="mt-4 grid gap-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-th-text-4">
          Scope filters (AND)
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Team filter" hint="Linear team keys, e.g. ENG">
            <ChipInput
              onChange={(team_filter) => onChange({ team_filter })}
              placeholder="Add team…"
              value={trigger.team_filter ?? []}
            />
          </Field>
          <Field label="Project filter" hint="Linear project ids or slugs">
            <ChipInput
              onChange={(project_filter) => onChange({ project_filter })}
              placeholder="Add project…"
              value={trigger.project_filter ?? []}
            />
          </Field>
          <Field
            label="Label filter"
            hint="Only fire when these labels present"
          >
            <ChipInput
              onChange={(label_filter) => onChange({ label_filter })}
              placeholder="Add label…"
              value={trigger.label_filter ?? []}
            />
          </Field>
          <Field label="Skip labels" hint="Bypass when any of these are present">
            <ChipInput
              onChange={(skip_label_filter) => onChange({ skip_label_filter })}
              placeholder="Add label…"
              value={trigger.skip_label_filter ?? []}
            />
          </Field>
          <Field label="Assignee filter">
            <ChipInput
              onChange={(assignee_filter) => onChange({ assignee_filter })}
              placeholder="Add assignee…"
              value={trigger.assignee_filter ?? []}
            />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-th-border pt-3">
        <div className="flex items-center gap-4">
          <Field label="Priority" className="w-24">
            <Input
              onChange={(event) =>
                onChange({
                  priority: Number.parseInt(event.target.value, 10) || 0,
                })
              }
              type="number"
              value={String(trigger.priority)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-th-text-2">
            <input
              checked={trigger.enabled}
              className="h-4 w-4 rounded border-th-border"
              onChange={(event) => onChange({ enabled: event.target.checked })}
              type="checkbox"
            />
            Enabled
          </label>
        </div>
      </div>
    </div>
  )
}
