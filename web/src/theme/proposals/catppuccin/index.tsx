import { RadioGroup } from 'radix-ui'
import { useThemeContext } from '../../provider'
import { useSystemMode } from '../../storage'
import type { Proposal } from '../../types'
import { ACCENTS, ACCENT_NAMES, COLORS, FLAVORS, FLAVOR_NAMES, type Accent, type Flavor } from './palette'
import { buildTheme, resolveFlavor, useSelection, useTheme, type Choice } from './theme'

// Catppuccin palette: MIT License, (c) Catppuccin (github.com/catppuccin/palette).

const SAMPLE = ['mauve', 'blue', 'green', 'peach', 'red'] as const
const ring = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring'

function Swatches({ flavor }: { flavor: Flavor }) {
  const c = COLORS[flavor]
  return (
    <span className="flex shrink-0 items-center overflow-hidden rounded border" style={{ background: c.base }}>
      <span className="px-1.5 text-[11px] font-semibold" style={{ color: c.text }}>
        Aa
      </span>
      {SAMPLE.map((a) => (
        <span key={a} className="size-3.5" style={{ background: c[a] }} />
      ))}
    </span>
  )
}

function Picker() {
  const sel = useSelection()
  const system = useSystemMode()
  const { setPreview } = useThemeContext()
  const preview = (flavor: Flavor, accent = sel.accent) => setPreview(buildTheme(flavor, accent))
  const current = resolveFlavor(sel, system)

  const rows: { value: Choice; label: string; flavor: Flavor; note?: string }[] = [
    ...FLAVORS.map((f) => ({
      value: f as Choice,
      label: FLAVOR_NAMES[f],
      flavor: f,
      note: f === 'latte' ? 'Light' : 'Dark',
    })),
    {
      value: 'system',
      label: 'Match system',
      flavor: system === 'dark' ? sel.darkFlavor : 'latte',
      note: `Latte in light, ${FLAVOR_NAMES[sel.darkFlavor]} in dark`,
    },
  ]

  return (
    <div className="flex flex-col gap-3" onMouseLeave={() => setPreview(null)}>
      <RadioGroup.Root
        aria-label="Flavor"
        value={sel.choice}
        onValueChange={(v) => sel.setChoice(v as Choice)}
        className="flex flex-col gap-1"
      >
        {rows.map((r) => {
          const on = sel.choice === r.value
          return (
            <RadioGroup.Item
              key={r.value}
              value={r.value}
              onMouseEnter={() => preview(r.flavor)}
              onFocus={() => preview(r.flavor)}
              onBlur={() => setPreview(null)}
              className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent ${ring} ${
                on ? 'border-primary bg-accent' : 'border-transparent'
              }`}
            >
              <Swatches flavor={r.flavor} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.label}</span>
                {r.note && <span className="block truncate text-xs text-muted-foreground">{r.note}</span>}
              </span>
              {on && <span className="text-xs text-muted-foreground">Selected</span>}
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>

      {sel.choice === 'system' && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          Dark flavor
          <RadioGroup.Root
            aria-label="Dark flavor"
            orientation="horizontal"
            value={sel.darkFlavor}
            onValueChange={(v) => sel.setDarkFlavor(v as Exclude<Flavor, 'latte'>)}
            className="flex gap-1"
          >
            {FLAVORS.slice(1).map((f) => (
              <RadioGroup.Item
                key={f}
                value={f}
                className={`rounded-md border px-2 py-0.5 text-foreground ${ring} ${
                  sel.darkFlavor === f ? 'border-primary bg-accent' : 'hover:bg-accent'
                }`}
              >
                {FLAVOR_NAMES[f]}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-sm">
          Accent <span className="text-xs text-muted-foreground">{ACCENT_NAMES[sel.accent]}</span>
        </span>
        <RadioGroup.Root
          aria-label="Accent color"
          orientation="horizontal"
          value={sel.accent}
          onValueChange={(v) => sel.setAccent(v as Accent)}
          className="flex flex-wrap gap-1.5"
        >
          {ACCENTS.map((a) => {
            const on = sel.accent === a
            return (
              <RadioGroup.Item
                key={a}
                value={a}
                aria-label={ACCENT_NAMES[a]}
                title={ACCENT_NAMES[a]}
                onMouseEnter={() => preview(current, a)}
                onFocus={() => preview(current, a)}
                onBlur={() => setPreview(null)}
                className={`size-5 rounded-full border border-foreground/20 ${ring} ${
                  on ? 'ring-2 ring-foreground ring-offset-2 ring-offset-popover' : ''
                }`}
                style={{ background: COLORS[current][a] }}
              />
            )
          })}
        </RadioGroup.Root>
      </div>
    </div>
  )
}

export const catppuccin: Proposal = {
  id: 'catppuccin',
  label: 'Catppuccin',
  description: 'The four Catppuccin flavors: Latte, Frappé, Macchiato, Mocha.',
  useTheme,
  Picker,
}
