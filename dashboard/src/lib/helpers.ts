import { ApiError } from './api'

export function formatQueryError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.payload?.error?.details) {
      return `${error.message}\n${formatJson(error.payload.error.details)}`
    }

    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function titleCase(value: string) {
  return value
    .replaceAll('_', ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function nilIfBlank(value: string | null) {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function isPositiveInteger(value: string) {
  return /^[1-9]\d*$/.test(value)
}
