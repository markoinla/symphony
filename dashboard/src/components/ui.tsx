import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-semibold transition duration-200 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'border-stone-950 bg-stone-950 text-stone-50 shadow-[0_14px_30px_-18px_rgba(17,24,39,0.8)] hover:-translate-y-0.5 hover:bg-stone-800',
        secondary:
          'border-white/70 bg-white/80 text-stone-700 backdrop-blur hover:border-stone-300 hover:bg-white',
        ghost: 'border-transparent bg-transparent text-stone-600 hover:bg-stone-100/70',
        danger: 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100',
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
  'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em]',
  {
    variants: {
      tone: {
        neutral: 'bg-stone-200/70 text-stone-700',
        running: 'bg-emerald-100 text-emerald-700',
        retrying: 'bg-amber-100 text-amber-700',
        danger: 'bg-rose-100 text-rose-700',
        live: 'bg-sky-100 text-sky-700',
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
        'rounded-[2rem] border border-white/70 bg-white/85 p-6 shadow-[0_25px_80px_-40px_rgba(120,53,15,0.35)] backdrop-blur',
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
        'w-full rounded-2xl border border-stone-200 bg-stone-50/80 px-4 py-3 text-sm text-stone-700 outline-none transition placeholder:text-stone-400 focus:border-amber-500 focus:bg-white focus:ring-4 focus:ring-amber-100',
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
        'min-h-28 w-full rounded-3xl border border-stone-200 bg-stone-50/80 px-4 py-3 text-sm text-stone-700 outline-none transition placeholder:text-stone-400 focus:border-amber-500 focus:bg-white focus:ring-4 focus:ring-amber-100',
        className,
      )}
      {...props}
    />
  )
}
