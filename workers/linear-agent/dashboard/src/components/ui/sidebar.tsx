import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

function SidebarProvider({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-provider"
      className={cn("flex min-h-screen w-full", className)}
      {...props}
    />
  )
}

function Sidebar({ className, ...props }: React.ComponentProps<"aside">) {
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "hidden w-64 shrink-0 border-r border-th-border bg-th-surface/70 md:block",
        className,
      )}
      {...props}
    />
  )
}

function SidebarInner({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inner"
      className={cn("sticky top-0 flex h-screen flex-col", className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex min-h-16 items-center px-4", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-2", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("border-t border-th-border p-3", className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("grid gap-1", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn("px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-th-text-4", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul data-slot="sidebar-menu" className={cn("grid gap-1", className)} {...props} />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("list-none", className)} {...props} />
}

function SidebarMenuButton({
  className,
  isActive = false,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-active={isActive}
      data-slot="sidebar-menu-button"
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-colors duration-100",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        isActive
          ? "bg-th-accent-muted text-th-text-1 shadow-xs"
          : "text-th-text-3 hover:bg-th-muted hover:text-th-text-1",
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInner,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
}
