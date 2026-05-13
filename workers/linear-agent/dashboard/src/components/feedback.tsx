import { Loader2, AlertCircle, CheckCircle2, Info } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

export function LoadingPanel({ compact = false, title }: { compact?: boolean; title: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center text-muted-foreground',
        compact ? 'py-6' : 'py-24',
      )}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
    </div>
  )
}

export function ErrorPanel({ detail, title }: { detail: string; title: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words">
        {detail}
      </AlertDescription>
    </Alert>
  )
}

export function FeedbackBanner({
  message,
  variant = 'info',
}: {
  message: string
  variant?: 'info' | 'success' | 'error'
}) {
  const Icon = variant === 'error' ? AlertCircle : variant === 'success' ? CheckCircle2 : Info
  return (
    <Alert
      variant={variant === 'error' ? 'destructive' : 'default'}
      className={cn(
        variant === 'success' &&
          'border-[color-mix(in_oklab,var(--th-success)_20%,transparent)] bg-[color-mix(in_oklab,var(--th-success)_8%,transparent)] text-[var(--th-success)] *:data-[slot=alert-description]:text-[color-mix(in_oklab,var(--th-success)_85%,var(--foreground))]',
      )}
    >
      <Icon aria-hidden />
      <AlertTitle>{message}</AlertTitle>
    </Alert>
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
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <p className={cn('text-sm font-medium text-foreground', icon ? 'mt-4' : '')}>{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}
