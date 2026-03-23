import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        primary:
          'bg-th-text-1 text-th-bg shadow-sm hover:opacity-85 active:opacity-75',
        secondary:
          'border border-th-border bg-th-surface text-th-text-2 shadow-sm hover:bg-th-muted hover:text-th-text-1',
        ghost:
          'text-th-text-3 hover:bg-th-muted hover:text-th-text-1',
        danger:
          'border border-th-danger/20 bg-th-danger-muted text-th-danger hover:bg-th-danger/10',
        link: 'text-th-accent underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-5',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
)

export function Button({
  className,
  size,
  variant,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ size, variant }), className)} {...props} />
}

