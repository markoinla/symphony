import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronsUpDown } from 'lucide-react'

import { cn } from '../../lib/utils'

export type ComboboxOption<T> = {
  value: T
  label: string
  description?: string
}

type ComboboxProps<T> = {
  options: ComboboxOption<T>[]
  onSearch: (query: string) => void
  onSelect: (option: ComboboxOption<T>) => void
  placeholder?: string
  searchPlaceholder?: string
  loading?: boolean
  emptyMessage?: string
  value?: string | null
  disabled?: boolean
  footer?: ReactNode
}

export function Combobox<T>({
  options,
  onSearch,
  onSelect,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  loading = false,
  emptyMessage = 'No results found.',
  value,
  disabled = false,
  footer,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => onSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search, onSearch])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(!open)
          if (!open) {
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        }}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-lg border border-th-border bg-th-surface px-3 text-sm outline-none transition',
          'focus:border-th-accent focus:ring-2 focus:ring-th-accent/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          value ? 'text-th-text-1' : 'text-th-text-4',
        )}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-th-text-4" />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-th-border bg-th-surface shadow-lg">
          <div className="p-2">
            <input
              ref={inputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              className="flex h-8 w-full rounded-md border border-th-border bg-th-bg px-2.5 text-sm text-th-text-1 outline-none placeholder:text-th-text-4 focus:border-th-accent"
            />
          </div>
          <div className="max-h-60 overflow-y-auto px-1 pb-1">
            {loading ? (
              <div className="px-3 py-4 text-center text-sm text-th-text-4">Searching...</div>
            ) : options.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-th-text-4">{emptyMessage}</div>
            ) : (
              options.map((option, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => {
                    onSelect(option)
                    setOpen(false)
                    setSearch('')
                  }}
                  className="flex w-full flex-col rounded-md px-3 py-2 text-left text-sm transition hover:bg-th-inset"
                >
                  <span className="font-medium text-th-text-1">{option.label}</span>
                  {option.description ? (
                    <span className="text-xs text-th-text-4">{option.description}</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          {footer ? <div className="border-t border-th-border px-3 py-2">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
