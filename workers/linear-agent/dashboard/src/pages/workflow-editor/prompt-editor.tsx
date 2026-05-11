import { useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/field'
import { usePreviewWorkflow } from '@/lib/api/workflows'
import { useTheme } from '@/hooks/use-theme'
import { formatQueryError } from '@/lib/helpers'

// Variables surfaced to the workflow author. Matches the contract in
// Track 1's `render.ts` (`issue.{id, identifier, ...}`, `attempt`,
// `prompt_context`, `new_comments`).
const variableGroups: { label: string; entries: string[] }[] = [
  {
    label: 'Issue',
    entries: [
      'issue.id',
      'issue.identifier',
      'issue.title',
      'issue.state',
      'issue.labels',
      'issue.comments',
      'issue.parent_issue',
    ],
  },
  {
    label: 'Run',
    entries: ['attempt', 'prompt_context', 'new_comments'],
  },
]

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
    previewMutation.mutate({ issue_identifier: issueIdent })
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
          <div className="flex items-end gap-2">
            <Field
              className="flex-1"
              label="Preview against issue"
              hint="Linear identifier (e.g. SYM-123). Autocomplete is mocked until track 2 ships."
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
              {previewMutation.data.prompt}
            </pre>
          ) : (
            <p className="mt-3 text-xs text-th-text-4">
              Click "Render preview" to see the prompt rendered against a
              sample issue.
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
                {group.entries.map((name) => (
                  <button
                    className="rounded bg-th-muted px-2 py-1 text-left font-mono text-[11px] text-th-text-2 transition hover:bg-th-accent-muted hover:text-th-accent"
                    key={name}
                    onClick={() => insertVariable(name)}
                    type="button"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
