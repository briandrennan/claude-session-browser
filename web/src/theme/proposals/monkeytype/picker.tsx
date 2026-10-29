import { Check, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useSystemMode } from '../../storage'
import type { Theme } from '../../types'
import { useThemeContext } from '../../provider'
import { fallback, useRoleSettings } from './settings'
import { ROLE_THEMES } from './themes'

type Filter = 'all' | 'light' | 'dark'

export function Picker() {
  const { theme, setPreview } = useThemeContext()
  const { settings, actions } = useRoleSettings()
  const system = useSystemMode()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [focusId, setFocusId] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const previewed = useRef<string | null>(null)

  const rows = useMemo(
    () =>
      ROLE_THEMES.filter(
        (t) => (filter === 'all' || t.mode === filter) && t.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query, filter],
  )

  const preview = (t: Theme | null) => {
    previewed.current = t?.id ?? null
    setPreview(t)
  }

  // Following the system: two slots are assigned, only the one in use is "selected".
  const assigned = (t: Theme) => settings.follow && (t.id === settings.lightId || t.id === settings.darkId)
  const isSelected = (t: Theme) =>
    settings.follow ? t.id === (system === 'dark' ? settings.darkId : settings.lightId) : t.id === theme.id

  // Roving tabindex: one tab stop, the focused row, else the selected row, else the first.
  const tabId = (rows.find((t) => t.id === focusId) ?? rows.find(isSelected) ?? rows[0])?.id

  // A hover preview must not outlive its row (search/filter can remove it under the pointer).
  useEffect(() => {
    if (previewed.current && !rows.some((t) => t.id === previewed.current)) {
      previewed.current = null
      setPreview(null)
    }
  }, [rows, setPreview])

  // Scroll the selected row into view on open.
  useEffect(() => {
    const box = list.current
    const el = box?.querySelector<HTMLElement>('[aria-selected=true]')
    if (box && el) box.scrollTop = el.offsetTop - box.offsetTop - (box.clientHeight - el.offsetHeight) / 2
  }, [])

  const commit = (t: Theme) => {
    // With "follow system" on, a theme fills the slot for its own mode.
    if (settings.follow) (t.mode === 'dark' ? actions.setDarkId : actions.setLightId)(t.id)
    else actions.setThemeId(t.id)
    preview(null)
  }

  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role=option]') ?? [])
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return preview(null)
    const items = buttons()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') items[Math.min(items.length - 1, i + 1)]?.focus()
    else if (e.key === 'ArrowUp') {
      if (i <= 0) document.getElementById('role-theme-filter')?.focus()
      else items[i - 1].focus()
    } else if (e.key === 'Home') items[0]?.focus()
    else if (e.key === 'End') items[items.length - 1]?.focus()
    else return
    e.preventDefault()
  }

  const slotName = (id: string, mode: 'light' | 'dark') => fallback(id, mode).name

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="role-theme-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                buttons().find((b) => b.tabIndex === 0)?.focus()
              }
            }}
            placeholder="Search"
            aria-label="Search themes"
            className="h-8 pl-7"
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          aria-label="Filter by mode"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div
        ref={list}
        role="listbox"
        aria-label="Themes"
        className="relative flex max-h-[320px] flex-col gap-1 overflow-y-auto"
        onKeyDown={onListKey}
        onMouseLeave={() => preview(null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) preview(null)
        }}
      >
        {rows.length === 0 && <p className="px-1 py-2 text-sm text-muted-foreground">No themes match.</p>}
        {rows.map((t) => (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={isSelected(t)}
            tabIndex={t.id === tabId ? 0 : -1}
            onClick={() => commit(t)}
            onMouseEnter={() => preview(t)}
            onFocus={() => {
              setFocusId(t.id)
              preview(t)
            }}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
            style={{
              background: t.ui.background,
              color: t.ui.foreground,
              borderColor: t.ui.border,
              outlineColor: t.ui.primary,
            }}
          >
            <span className="flex-1 truncate font-medium">{t.name}</span>
            {assigned(t) && (
              <span
                className="rounded-sm border px-1 text-[10px] uppercase leading-4 tracking-wide"
                style={{ borderColor: t.ui.border, color: t.ui['muted-foreground'] }}
              >
                {t.mode === 'dark' ? 'Dark' : 'Light'}
              </span>
            )}
            <span className="flex items-center gap-1" aria-hidden>
              {[t.ui.primary, t.ui.highlight, t.ui['muted-foreground']].map((c, i) => (
                <span key={i} className="size-2.5 rounded-full" style={{ background: c }} />
              ))}
            </span>
            <Check className={isSelected(t) ? 'size-4' : 'size-4 opacity-0'} aria-hidden />
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={settings.follow} onCheckedChange={(v) => actions.setFollow(v === true)} />
        Follow system light or dark
      </label>
      {settings.follow && (
        <p className="text-xs text-muted-foreground">
          Light: {slotName(settings.lightId, 'light')} · Dark: {slotName(settings.darkId, 'dark')}. Choosing a theme
          sets the one for its mode.
        </p>
      )}
    </div>
  )
}
