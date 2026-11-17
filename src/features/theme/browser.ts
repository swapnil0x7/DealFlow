import { ThemeController, THEME_MEDIA_QUERY } from './controller'

let controller: ThemeController | undefined

export function initializeTheme(): ThemeController {
  if (!controller) {
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      /* Fall back to system appearance. */
    }
    controller = new ThemeController({
      root: document.documentElement,
      storage,
      media: window.matchMedia(THEME_MEDIA_QUERY),
      events: window,
    })
  }
  return controller
}

export function getThemeController(): ThemeController {
  if (!controller) throw new Error('Initialize appearance before rendering its controls.')
  return controller
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    controller?.dispose()
    controller = undefined
  })
