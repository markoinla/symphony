'use client'

import * as React from 'react'

import {
  Dialog,
  DialogClose,
  DialogContent as DialogContentPrimitive,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

// Targets in portaled popups that should NOT count as "outside" the
// dialog — without this, clicking an item in a Base UI Combobox popup
// (rendered to document.body) closes the dialog before selection
// commits.
const PORTAL_GUARD_SELECTOR = [
  '[data-slot="combobox-content"]',
  '[data-slot="combobox-list"]',
  '[data-slot="combobox-item"]',
  '[data-slot="combobox-positioner"]',
  '[data-slot="select-content"]',
  '[data-slot="select-item"]',
  '[data-slot="select-item-indicator"]',
  '[data-slot="select-scroll-up-button"]',
  '[data-slot="select-scroll-down-button"]',
].join(',')

function isInsidePortaledPopup(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.closest(PORTAL_GUARD_SELECTOR) !== null
}

function DialogContent({
  onPointerDownOutside,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogContentPrimitive>) {
  return (
    <DialogContentPrimitive
      onPointerDownOutside={(event) => {
        if (isInsidePortaledPopup(event.target)) {
          event.preventDefault()
          return
        }
        onPointerDownOutside?.(event)
      }}
      onInteractOutside={(event) => {
        if (isInsidePortaledPopup(event.target)) {
          event.preventDefault()
          return
        }
        onInteractOutside?.(event)
      }}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
