import { usePersisted } from '../../storage'
import type { Mode } from '../../types'
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById } from './themes'

const isString = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

// Shared by useTheme and the Picker: usePersisted keys are one store per key.
// Default is "follow system" so a dark-OS user is not greeted with a white UI.
export function useRoleSettings() {
  const [themeId, setThemeId] = usePersisted('theme.roles.theme', DEFAULT_LIGHT, isString)
  const [follow, setFollow] = usePersisted('theme.roles.follow', true, isBool)
  const [lightId, setLightId] = usePersisted('theme.roles.light', DEFAULT_LIGHT, isString)
  const [darkId, setDarkId] = usePersisted('theme.roles.dark', DEFAULT_DARK, isString)
  return {
    settings: { themeId, follow, lightId, darkId },
    actions: { setThemeId, setFollow, setLightId, setDarkId },
  }
}

export const fallback = (id: string, mode: Mode) =>
  themeById(id) ?? themeById(mode === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT)!
