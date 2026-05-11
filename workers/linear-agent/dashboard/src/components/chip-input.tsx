import { useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function ChipInput({
  value,
  onChange,
  placeholder,
  monospace = false,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  monospace?: boolean
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (value.includes(trimmed)) {
      setDraft('')
      return
    }
    onChange([...value, trimmed])
    setDraft('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {value.map((chip) => (
        <span
          key={chip}
          className={cn(
            'inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground',
            monospace && 'font-mono',
          )}
        >
          {chip}
          <button
            aria-label={`Remove ${chip}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(value.filter((c) => c !== chip))}
            type="button"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Input
        className={cn(
          'h-6 w-auto flex-1 min-w-[120px] border-0 px-1 py-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0',
          monospace && 'font-mono',
        )}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? placeholder : ''}
        value={draft}
      />
    </div>
  )
}
