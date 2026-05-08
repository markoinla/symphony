import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'

import { Button } from './ui'
import {
  changelog,
  getLastSeenId,
  setLastSeenId,
  unreadCount,
  type ChangelogEntry,
  type ChangelogTag,
} from '../lib/changelog'
import { cn } from '../lib/utils'

const TAG_LABEL: Record<ChangelogTag, string> = {
  feature: 'New',
  fix: 'Fix',
  improvement: 'Improved',
}

const TAG_CLASS: Record<ChangelogTag, string> = {
  feature: 'bg-th-accent-muted text-th-accent',
  fix: 'bg-th-warning-muted text-th-warning',
  improvement: 'bg-th-muted text-th-text-2',
}

export function ChangelogButton() {
  const [open, setOpen] = useState(false)
  const [lastSeenId, setLastSeenIdState] = useState<string | null>(() => getLastSeenId())
  const containerRef = useRef<HTMLDivElement | null>(null)

  const unread = unreadCount(changelog, lastSeenId)
  const newest = changelog[0]

  useEffect(() => {
    if (!open) return
    function handlePointer(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && newest && lastSeenId !== newest.id) {
      setLastSeenId(newest.id)
      setLastSeenIdState(newest.id)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        aria-label={unread > 0 ? `What's new (${unread} unread)` : "What's new"}
        onClick={handleToggle}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-th-accent ring-2 ring-th-bg"
          />
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-th-border bg-th-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-th-border px-4 py-3">
            <p className="text-sm font-semibold text-th-text-1">What&apos;s new</p>
            {unread > 0 && (
              <span className="text-[11px] text-th-text-4">{unread} new</span>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {changelog.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-th-text-4">
                No updates yet.
              </p>
            ) : (
              <ul className="divide-y divide-th-border/70">
                {changelog.map((entry) => (
                  <ChangelogItem key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ChangelogItem({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-th-text-1">{entry.title}</p>
        <time className="shrink-0 text-[11px] text-th-text-4">{entry.date}</time>
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {entry.tag && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              TAG_CLASS[entry.tag],
            )}
          >
            {TAG_LABEL[entry.tag]}
          </span>
        )}
        {entry.description && (
          <p className="text-[12px] leading-relaxed text-th-text-3">{entry.description}</p>
        )}
      </div>
    </li>
  )
}
