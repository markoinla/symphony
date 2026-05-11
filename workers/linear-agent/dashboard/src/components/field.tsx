import * as React from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function Field({
  children,
  label,
  hint,
  className,
}: {
  children: React.ReactNode
  label: string
  hint?: string
  className?: string
}) {
  return (
    <label className={cn('grid min-w-0 gap-1.5', className)}>
      <Label asChild>
        <span>{label}</span>
      </Label>
      {children}
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}
