import { createStore } from 'zustand/vanilla'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ThemeMode = Exclude<ThemePreference, 'system'>
export const THEME_STORAGE_KEY = 'dealdesk:theme'
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

interface ThemeRoot {
  dataset: { theme?: string; agThemeMode?: string; themePreference?: string }
  style: { colorScheme: string }
}
interface Options {
  root: ThemeRoot
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}
export const themePreference = (value: unknown): ThemePreference =>
  value === 'light' || value === 'dark' ? value : 'system'

/** Appearance has its own lifetime, independent of workspace loading, resets, and saved deals. */
export class ThemeController {
  readonly store
  private readonly options: Options

  constructor(options: Options) {
    this.options = options
    let preference: ThemePreference = 'system'
    try {
      preference = themePreference(options.storage?.getItem(THEME_STORAGE_KEY))
    } catch {
      /* Storage can be unavailable. */
    }
    this.store = createStore<{ preference: ThemePreference; resolved: ThemeMode }>(() => ({
      preference,
      resolved: this.resolve(preference),
    }))
    this.apply(preference)
    options.media.addEventListener('change', this.systemChanged)
    options.events?.addEventListener('storage', this.storageChanged)
  }

  private resolve(preference: ThemePreference): ThemeMode {
    return preference === 'system' ? (this.options.media.matches ? 'dark' : 'light') : preference
  }

  private apply(preference: ThemePreference): void {
    const resolved = this.resolve(preference)
    const { root } = this.options
    root.dataset.theme = resolved
    root.dataset.agThemeMode = resolved
    root.dataset.themePreference = preference
    root.style.colorScheme = resolved
    this.store.setState((previous) =>
      previous.preference === preference && previous.resolved === resolved
        ? previous
        : { preference, resolved },
    )
  }

  setPreference = (preference: ThemePreference): void => {
    this.apply(preference)
    try {
      this.options.storage?.setItem(THEME_STORAGE_KEY, preference)
    } catch {
      /* The choice still works for this visit. */
    }
  }

  private systemChanged = (): void => {
    if (this.store.getState().preference === 'system') this.apply('system')
  }

  private storageChanged = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== this.options.storage) return
    if (event.key === THEME_STORAGE_KEY || event.key === null)
      this.apply(themePreference(event.newValue))
  }

  dispose(): void {
    this.options.media.removeEventListener('change', this.systemChanged)
    this.options.events?.removeEventListener('storage', this.storageChanged)
  }
}
