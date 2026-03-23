import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/utils'

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn('text-sm font-medium text-th-text-2', className)}
      {...props}
    />
  )
}

export function Field({ children, label, hint }: { children: ReactNode; label: string; hint?: string }) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-sm font-medium text-th-text-2">{label}</span>
      {children}
      {hint ? <span className="text-xs text-th-text-4">{hint}</span> : null}
    </label>
  )
}
