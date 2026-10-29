import { FlaskConical, Palette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PROPOSALS } from './proposals'
import { useThemeContext } from './provider'
import type { ChartMode } from './types'

export function ThemeMenu() {
  const { proposal, setProposal, chartMode, setChartMode, setPreview } = useThemeContext()
  const { Picker } = proposal
  return (
    <Popover onOpenChange={(open) => !open && setPreview(null)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Appearance">
          <Palette />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-3">
        {/* Theme lab: temporary, removed once a proposal is chosen. */}
        <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FlaskConical className="size-3.5" /> Theme lab
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={proposal.id}
            onValueChange={(v) => {
              if (!v) return
              setPreview(null)
              setProposal(v)
            }}
            className="w-full"
          >
            {PROPOSALS.map((p) => (
              <ToggleGroupItem key={p.id} value={p.id} className="flex-1">
                {p.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">{proposal.description}</p>
        </div>

        <Picker />

        <Separator />
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Chart colors</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={chartMode}
            onValueChange={(v) => v && setChartMode(v as ChartMode)}
          >
            <ToggleGroupItem value="categorical">Distinct</ToggleGroupItem>
            <ToggleGroupItem value="tonal">Tonal</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </PopoverContent>
    </Popover>
  )
}
