import { useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field } from '@/components/field'
import { usePreviewWorkflow } from '@/lib/api/workflows'
import { useTheme } from '@/hooks/use-theme'
import { formatQueryError } from '@/lib/helpers'

type VariableEntry = { name: string; hint: string }
type PreviewKind = 'linear_issue' | 'github_issue' | 'github_pr' | 'sentry_event' | 'generic'

// Variables surfaced to the workflow author. Matches the contract in
// `render.ts`: generic `subject` / `context` plus defensive per-kind
// sugar namespaces that become empty strings when the kind does not match.
const variableGroups: { label: string; entries: VariableEntry[] }[] = [
  {
    label: 'Generic',
    entries: [
      { name: 'subject.kind', hint: 'Always resolves for every subject kind.' },
      { name: 'subject.title', hint: 'Resolves when the source provides a title.' },
      { name: 'context | json', hint: 'Always resolves; opaque trigger context as JSON.' },
    ],
  },
  {
    label: 'Issue sugar',
    entries: [
      { name: 'issue.title', hint: 'Only resolves for linear_issue and github_issue.' },
      { name: 'issue.description', hint: 'Shared issue body; Linear description or GitHub body.' },
      { name: 'issue.labels', hint: 'Only resolves for linear_issue and github_issue.' },
      { name: 'issue.state', hint: 'Only resolves for linear_issue and github_issue.' },
      { name: 'issue.parent_issue', hint: 'Linear-only; empty for GitHub issues.' },
      { name: 'issue.assignees', hint: 'GitHub-only; empty for Linear issues.' },
    ],
  },
  {
    label: 'PR / event sugar',
    entries: [
      { name: 'pr.title', hint: 'Only resolves for github_pr.' },
      { name: 'pr.branch', hint: 'Only resolves for github_pr.' },
      { name: 'event.title', hint: 'Only resolves for sentry_event.' },
      { name: 'event.culprit', hint: 'Only resolves for sentry_event.' },
      { name: 'payload | json', hint: 'Only resolves for generic webhook subjects.' },
    ],
  },
  {
    label: 'Run',
    entries: [
      { name: 'attempt', hint: 'Always resolves for the current run attempt.' },
      { name: 'prompt_context', hint: 'Legacy rendered context string.' },
      { name: 'new_comments', hint: 'Linear continuation comments, when present.' },
    ],
  },
]

const previewSubjects: Record<PreviewKind, Record<string, unknown>> = {
  linear_issue: {
    kind: 'linear_issue',
    id: 'lin-issue-1',
    identifier: 'SYM-MOCK',
    title: 'Preview Linear issue',
    description: 'Linear issue body',
    state: 'Todo',
    labels: ['preview'],
    parent_issue: { id: 'lin-parent-1', identifier: 'SYM-1', title: 'Parent' },
    comments: [],
  },
  github_issue: {
    kind: 'github_issue',
    id: 'gh-issue-1',
    number: 42,
    title: 'Preview GitHub issue',
    body: 'GitHub issue body',
    state: 'open',
    labels: ['preview'],
    assignees: ['octocat'],
    repository: 'acme/widgets',
  },
  github_pr: {
    kind: 'github_pr',
    id: 'gh-pr-1',
    number: 7,
    title: 'Preview GitHub PR',
    body: 'Pull request body',
    state: 'open',
    branch: 'feature/prompt-preview',
    base_branch: 'main',
    repository: 'acme/widgets',
    labels: ['preview'],
  },
  sentry_event: {
    kind: 'sentry_event',
    id: 'sentry-1',
    title: 'TypeError: undefined is not a function',
    message: 'Cannot call undefined value',
    culprit: 'checkout.submit',
    project: 'web-app',
    level: 'error',
    payload: { environment: 'production' },
  },
  generic: {
    kind: 'generic',
    external_id: 'nightly-build',
    title: 'Preview generic webhook',
    payload: { action: 'nightly', ref: 'main' },
  },
}

export function PromptEditor({
  workflowId,
  value,
  onChange,
}: {
  workflowId: string
  value: string
  onChange: (next: string) => void
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const { dark } = useTheme()
  const [issueIdent, setIssueIdent] = useState('SYM-MOCK')
  const [previewKind, setPreviewKind] = useState<PreviewKind>('linear_issue')
  const previewMutation = usePreviewWorkflow(workflowId)

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
  }

  function insertVariable(name: string) {
    const editor = editorRef.current
    const snippet = `{{ ${name} }}`
    if (!editor) {
      onChange(value + snippet)
      return
    }
    const selection = editor.getSelection()
    if (!selection) {
      onChange(value + snippet)
      return
    }
    editor.executeEdits('insert-variable', [
      { range: selection, text: snippet, forceMoveMarkers: true },
    ])
    editor.focus()
  }

  function runPreview() {
    const subject = { ...previewSubjects[previewKind] }
    if (previewKind === 'linear_issue') {
      subject.id = issueIdent
      subject.identifier = issueIdent
    }
    previewMutation.mutate({
      issue_id: issueIdent,
      subject,
      context: {
        preview: true,
        source: previewKind,
        nested: { special: 'quotes " and newline\n' },
      },
    })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="grid gap-4">
        <div className="overflow-hidden rounded-lg border border-th-border">
          <Editor
            defaultLanguage="markdown"
            height="480px"
            onChange={(next) => onChange(next ?? '')}
            onMount={handleMount}
            options={{
              minimap: { enabled: false },
              wordWrap: 'on',
              fontSize: 13,
              padding: { top: 12, bottom: 12 },
              scrollBeyondLastLine: false,
            }}
            theme={dark ? 'vs-dark' : 'vs'}
            value={value}
          />
        </div>

        <div className="rounded-lg border border-th-border bg-th-surface p-4">
          <div className="grid gap-3 md:grid-cols-[180px_1fr_auto] md:items-end">
            <Field label="Preview subject" hint="Render against any supported subject kind.">
              <Select
                onValueChange={(next) => setPreviewKind(next as PreviewKind)}
                value={previewKind}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="linear_issue">Linear issue</SelectItem>
                  <SelectItem value="github_issue">GitHub issue</SelectItem>
                  <SelectItem value="github_pr">GitHub PR</SelectItem>
                  <SelectItem value="sentry_event">Sentry event</SelectItem>
                  <SelectItem value="generic">Generic webhook</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Subject id"
              hint="Used for the Linear issue sample; other samples use connected-source shaped mock data."
            >
              <Input
                onChange={(event) => setIssueIdent(event.target.value)}
                placeholder="SYM-123"
                value={issueIdent}
              />
            </Field>
            <Button
              disabled={previewMutation.isPending}
              onClick={runPreview}
              type="button"
            >
              {previewMutation.isPending ? 'Rendering…' : 'Render preview'}
            </Button>
          </div>

          {previewMutation.isError ? (
            <p className="mt-3 text-xs text-th-danger">
              {formatQueryError(previewMutation.error)}
            </p>
          ) : null}

          {previewMutation.data ? (
            <pre className="mt-3 max-h-[280px] overflow-auto whitespace-pre-wrap rounded border border-th-border bg-th-bg p-3 text-[12px] leading-5 text-th-text-2">
              {previewMutation.data.rendered}
            </pre>
          ) : (
            <p className="mt-3 text-xs text-th-text-4">
              Click "Render preview" to see the prompt rendered against a
              sample subject of any supported kind.
            </p>
          )}
        </div>
      </div>

      <aside className="rounded-lg border border-th-border bg-th-surface p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-th-text-4">
          Variables
        </p>
        <p className="mt-1 text-[12px] text-th-text-4">
          Click to insert at cursor.
        </p>
        <div className="mt-3 grid gap-4">
          {variableGroups.map((group) => (
            <div key={group.label}>
              <p className="text-[11px] font-semibold text-th-text-3">
                {group.label}
              </p>
              <div className="mt-1.5 grid gap-1">
                {group.entries.map((entry) => (
                  <div key={entry.name}>
                    <Button
                      className="h-auto w-full justify-start rounded bg-th-muted px-2 py-1 text-left font-mono text-[11px] font-normal text-th-text-2 shadow-none hover:bg-th-accent-muted hover:text-th-accent"
                      onClick={() => insertVariable(entry.name)}
                      type="button"
                      variant="ghost"
                    >
                      {entry.name}
                    </Button>
                    <p className="mt-0.5 px-1 text-[10px] leading-4 text-th-text-4">
                      {entry.hint}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
