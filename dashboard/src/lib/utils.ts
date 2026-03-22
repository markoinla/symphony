import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 'n/a'
  }

  return new Intl.NumberFormat('en-US').format(value)
}

export function formatRuntimeFromSeconds(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0m 0s'
  }

  const wholeSeconds = Math.max(Math.trunc(value), 0)
  const minutes = Math.floor(wholeSeconds / 60)
  const seconds = wholeSeconds % 60

  return `${minutes}m ${seconds}s`
}

export function runtimeSince(timestamp: string | null | undefined, now: number) {
  if (!timestamp) {
    return '0m 0s'
  }

  const startedAt = new Date(timestamp).getTime()

  if (Number.isNaN(startedAt)) {
    return '0m 0s'
  }

  return formatRuntimeFromSeconds((now - startedAt) / 1000)
}

export function formatDateTime(timestamp: string | null | undefined) {
  if (!timestamp) {
    return 'n/a'
  }

  const value = new Date(timestamp)

  if (Number.isNaN(value.getTime())) {
    return timestamp
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

export function formatClock(timestamp: string | null | undefined) {
  if (!timestamp) {
    return ''
  }

  const value = new Date(timestamp)

  if (Number.isNaN(value.getTime())) {
    return timestamp
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

export function estimateCost(inputTokens: number, outputTokens: number) {
  // Claude Sonnet pricing: $3/MTok input, $15/MTok output
  const inputCost = (inputTokens / 1_000_000) * 3
  const outputCost = (outputTokens / 1_000_000) * 15
  const total = inputCost + outputCost

  if (total < 0.01) {
    return `$${total.toFixed(4)}`
  }

  return `$${total.toFixed(2)}`
}

export function runtimeBetween(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  now: number,
) {
  if (!startedAt) {
    return '0m 0s'
  }

  const start = new Date(startedAt).getTime()

  if (Number.isNaN(start)) {
    return '0m 0s'
  }

  const end = endedAt ? new Date(endedAt).getTime() : now

  if (Number.isNaN(end)) {
    return '0m 0s'
  }

  return formatRuntimeFromSeconds((end - start) / 1000)
}

export function groupConsecutiveByType<T extends { type: string }>(items: T[], type: string) {
  type Group = { type: string; items: T[] }
  const groups: Array<T | Group> = []

  for (const item of items) {
    const previous = groups.at(-1)

    if (
      item.type === type &&
      previous &&
      'items' in previous &&
      previous.type === `${type}_group`
    ) {
      previous.items.push(item)
      continue
    }

    if (item.type === type) {
      groups.push({ type: `${type}_group`, items: [item] })
      continue
    }

    groups.push(item)
  }

  return groups
}
