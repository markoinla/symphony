export type ChangelogTag = 'feature' | 'fix' | 'improvement'

export type ChangelogEntry = {
  id: string
  date: string
  title: string
  description?: string
  tag?: ChangelogTag
}

// Newest first. Add new entries at the top.
export const changelog: ChangelogEntry[] = [
  {
    id: '2026-05-08-changelog-panel',
    date: '2026-05-08',
    title: '"What\'s new" panel',
    description:
      'Recent updates show up in this menu. New entries since your last visit are flagged with a dot.',
    tag: 'feature',
  },
  {
    id: '2026-04-28-linear-chat-controls',
    date: '2026-04-28',
    title: 'Linear agent chat controls',
    description: 'Fixed a regression in the inline Linear agent chat controls.',
    tag: 'fix',
  },
  {
    id: '2026-04-27-linear-oauth-refresh',
    date: '2026-04-27',
    title: 'Linear OAuth token refresh',
    description: 'Linear tokens are now refreshed automatically before expiry.',
    tag: 'fix',
  },
  {
    id: '2026-03-27-webhook-queue',
    date: '2026-03-27',
    title: 'Durable webhook queue + expanded diagnostics',
    description:
      'Webhook hints persist across restarts, orphaned engine processes are reaped, and /diagnostics now exposes worker health, dead letters, and 24h error distribution.',
    tag: 'improvement',
  },
  {
    id: '2026-03-26-analytics-24h',
    date: '2026-03-26',
    title: '24-hour view on Analytics',
    description: 'Added a 24-hour granularity option and rebalanced chart colors.',
    tag: 'feature',
  },
]

const STORAGE_KEY = 'symphony.changelog.lastSeenId'

export function getLastSeenId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setLastSeenId(id: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // localStorage can throw in private browsing — fail quietly.
  }
}

export function unreadCount(entries: ChangelogEntry[], lastSeenId: string | null): number {
  if (entries.length === 0) return 0
  if (!lastSeenId) return entries.length
  const idx = entries.findIndex((entry) => entry.id === lastSeenId)
  if (idx === -1) return entries.length
  return idx
}
