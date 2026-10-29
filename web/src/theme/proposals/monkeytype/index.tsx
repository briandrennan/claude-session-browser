import { useSystemMode } from '../../storage'
import type { Proposal, Theme } from '../../types'
import { Picker } from './picker'
import { fallback, useRoleSettings } from './settings'
import { DEFAULT_LIGHT, themeById } from './themes'

function useTheme(): Theme {
  const { settings: s } = useRoleSettings()
  const system = useSystemMode()
  if (!s.follow) return themeById(s.themeId) ?? fallback(DEFAULT_LIGHT, 'light')
  return system === 'dark' ? fallback(s.darkId, 'dark') : fallback(s.lightId, 'light')
}

export const monkeytype: Proposal = {
  id: 'monkeytype',
  label: 'Role themes',
  description: 'A small set of color roles per theme, a curated catalog, and live preview on hover.',
  useTheme,
  Picker,
}
