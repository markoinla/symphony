import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-9 w-full appearance-none rounded-lg border border-th-border bg-th-surface px-3 pr-8 text-sm text-th-text-1 outline-none transition',
        'focus:border-th-accent focus:ring-2 focus:ring-th-accent/20',
        'bg-[length:16px] bg-[center_right_8px] bg-no-repeat',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b6b80' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    />
  )
}
