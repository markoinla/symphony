import { cn } from '../../lib/utils'

export function LoadingPanel({ compact = false, title }: { compact?: boolean; title: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-6' : 'py-24')}>
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-th-border border-t-th-accent" />
      <p className="mt-4 text-sm font-medium text-th-text-2">{title}</p>
    </div>
  )
}

export function ErrorPanel({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="rounded-lg border border-th-danger/15 bg-th-danger-muted px-5 py-4">
      <p className="text-sm font-medium text-th-danger">{title}</p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-th-danger/70">{detail}</p>
    </div>
  )
}

export function FeedbackBanner({ message, variant = 'info' }: { message: string; variant?: 'info' | 'success' | 'error' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        variant === 'error'
          ? 'border-th-danger/20 bg-th-danger-muted text-th-danger'
          : variant === 'success'
            ? 'border-th-success/20 bg-th-success-muted text-th-success'
            : 'border-th-border bg-th-muted text-th-text-2',
      )}
    >
      {message}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-th-muted">
          {icon}
        </div>
      ) : null}
      <p className={cn('text-sm font-medium text-th-text-2', icon ? 'mt-4' : '')}>{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-th-text-4">{description}</p>
    </div>
  )
}
