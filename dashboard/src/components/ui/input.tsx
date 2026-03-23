import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-lg border border-th-border bg-th-surface px-3 text-sm text-th-text-1 outline-none transition placeholder:text-th-text-4 focus:border-th-accent focus:ring-2 focus:ring-th-accent/20',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full rounded-lg border border-th-border bg-th-surface px-3 py-2 text-sm text-th-text-1 outline-none transition placeholder:text-th-text-4 focus:border-th-accent focus:ring-2 focus:ring-th-accent/20 resize-y',
        className,
      )}
      {...props}
    />
  )
}
