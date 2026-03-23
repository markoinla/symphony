import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Dialog(props: RadixDialog.DialogProps) {
  return <RadixDialog.Root {...props} />
}

export function DialogTrigger(props: ComponentProps<typeof RadixDialog.Trigger>) {
  return <RadixDialog.Trigger {...props} />
}

export function DialogContent({
  children,
  className,
  title,
  description,
  ...props
}: ComponentProps<typeof RadixDialog.Content> & { title: string; description?: string }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
      <RadixDialog.Content
        className={cn(
          'dialog-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-xl border border-th-border bg-th-surface p-6 shadow-2xl shadow-black/10',
          'max-h-[85vh] overflow-y-auto',
          className,
        )}
        {...props}
      >
        <div className="mb-5 space-y-1.5 pr-8">
          <RadixDialog.Title className="text-base font-semibold text-th-text-1">
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="text-sm text-th-text-3">
              {description}
            </RadixDialog.Description>
          ) : null}
        </div>
        {children}
        <RadixDialog.Close className="absolute right-4 top-4 rounded-md p-1.5 text-th-text-4 transition hover:bg-th-muted hover:text-th-text-2">
          <X className="h-4 w-4" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}
