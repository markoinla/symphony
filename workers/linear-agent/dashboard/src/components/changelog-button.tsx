import { useState } from 'react'
import { Bell } from 'lucide-react'

import { Button } from './ui'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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
  feature: 'bg-accent text-accent-foreground',
  fix: 'bg-[color-mix(in_oklab,var(--th-warning)_15%,transparent)] text-[var(--th-warning)]',
  improvement: 'bg-muted text-foreground',
}

export function ChangelogButton() {
  const [open, setOpen] = useState(false)
  const [lastSeenId, setLastSeenIdState] = useState<string | null>(() => getLastSeenId())

  const unread = unreadCount(changelog, lastSeenId)
  const newest = changelog[0]

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && newest && lastSeenId !== newest.id) {
      setLastSeenId(newest.id)
      setLastSeenIdState(newest.id)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          aria-label={unread > 0 ? `What's new (${unread} unread)` : "What's new"}
          className="relative"
          size="icon"
          type="button"
          variant="ghost"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute right-2 top-2 size-1.5 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">What&apos;s new</p>
          {unread > 0 && (
            <span className="text-[11px] text-muted-foreground">{unread} new</span>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {changelog.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
              No updates yet.
            </p>
          ) : (
            <ul className="divide-y">
              {changelog.map((entry) => (
                <ChangelogItem key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChangelogItem({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">{entry.title}</p>
        <time className="shrink-0 text-[11px] text-muted-foreground">{entry.date}</time>
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
          <p className="text-[12px] leading-relaxed text-muted-foreground">{entry.description}</p>
        )}
      </div>
    </li>
  )
}
