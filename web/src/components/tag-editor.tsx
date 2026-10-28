import { useState } from 'react'
import { Check, Plus, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Props = {
  sessionId: string
  tags: string[]
  vocabulary: string[]
  onChange: (tags: string[]) => void
  onVocabulary?: (tags: string[]) => void
  compact?: boolean
}

export function TagEditor({ sessionId, tags, vocabulary, onChange, onVocabulary, compact }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const save = async (next: string[]) => {
    onChange(next) // optimistic
    const res = await api.setEnrichment(sessionId, next)
    onChange(res.tags)
    const added = res.tags.filter((t) => !vocabulary.includes(t))
    if (added.length) onVocabulary?.([...vocabulary, ...added])
  }
  const toggle = (t: string) => save(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])
  const q = query.trim()

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {tags.map((t) => (
        <Badge key={t} variant="secondary" className="font-normal">
          {t}
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size={compact ? 'icon-xs' : 'xs'} aria-label="Edit tags" className="text-muted-foreground">
            {compact ? <Tag /> : (<><Tag /> {tags.length ? 'Edit' : 'Classify'}</>)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            <CommandInput placeholder="Find or create tag…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>No tags.</CommandEmpty>
              <CommandGroup>
                {vocabulary.map((t) => (
                  <CommandItem key={t} value={t} onSelect={() => toggle(t)}>
                    <Check className={cn('size-4', tags.includes(t) ? 'opacity-100' : 'opacity-0')} />
                    {t}
                  </CommandItem>
                ))}
                {q && !vocabulary.includes(q) && (
                  <CommandItem value={`create:${q}`} onSelect={() => (toggle(q), setQuery(''))}>
                    <Plus className="size-4" /> Create “{q}”
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
