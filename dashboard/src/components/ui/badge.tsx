import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-th-muted text-th-text-3',
        running: 'bg-th-success-muted text-th-success',
        retrying: 'bg-th-warning-muted text-th-warning',
        danger: 'bg-th-danger-muted text-th-danger',
        live: 'bg-th-accent-muted text-th-accent',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
)

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
