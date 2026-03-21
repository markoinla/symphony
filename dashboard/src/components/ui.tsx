import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary:
          'border-zinc-100 bg-zinc-100 text-zinc-900 hover:bg-white',
        secondary:
          'border-zinc-800 bg-transparent text-zinc-300 hover:border-zinc-600 hover:text-zinc-100',
        ghost: 'border-transparent bg-transparent text-zinc-400 hover:text-zinc-200',
        danger: 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20',
      },
    },
    defaultVariants: {
      variant: 'primary',
    },
  },
)

export function Button({
  className,
  variant,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />
}

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-zinc-800 text-zinc-400',
        running: 'bg-emerald-500/10 text-emerald-400',
        retrying: 'bg-amber-500/10 text-amber-400',
        danger: 'bg-red-500/10 text-red-400',
        live: 'bg-indigo-500/10 text-indigo-400',
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
        'rounded-xl border border-zinc-800 bg-zinc-900 p-6',
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
        'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30',
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
        'min-h-24 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30',
        className,
      )}
      {...props}
    />
  )
}
