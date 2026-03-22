import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary:
          'border-th-text-1 bg-th-text-1 text-th-bg hover:opacity-80',
        secondary:
          'border-th-border bg-transparent text-th-text-2 hover:border-th-border-muted hover:text-th-text-1',
        ghost: 'border-transparent bg-transparent text-th-text-3 hover:text-th-text-1',
        danger: 'border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20',
      },
      size: {
        default: 'px-3.5 py-2',
        sm: 'px-3 py-1.5 text-[13px]',
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

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-th-muted text-th-text-3',
        running: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        retrying: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
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

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-th-border bg-th-surface p-4 sm:p-6',
        className,
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-th-border bg-th-inset px-3.5 py-2.5 text-sm text-th-text-1 outline-none transition placeholder:text-th-text-4 focus:border-th-accent focus:ring-1 focus:ring-th-accent/30',
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
        'min-h-24 w-full rounded-lg border border-th-border bg-th-inset px-3.5 py-2.5 text-sm text-th-text-1 outline-none transition placeholder:text-th-text-4 focus:border-th-accent focus:ring-1 focus:ring-th-accent/30',
        className,
      )}
      {...props}
    />
  )
}
