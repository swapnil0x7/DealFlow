import { describe, expect, it, vi } from 'vitest'
import { ThemeController, THEME_STORAGE_KEY } from './controller'

function setup(saved: string | null = null, dark = false) {
  const root = { dataset: {} as Record<string, string | undefined>, style: { colorScheme: '' } }
  const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() }
  const mediaListeners = new Set<() => void>()
  const storageListeners = new Set<(event: StorageEvent) => void>()
  const media = {
    matches: dark,
    addEventListener: vi.fn((_event: string, listener: unknown) => {
      mediaListeners.add(listener as () => void)
    }),
    removeEventListener: vi.fn((_event: string, listener: unknown) => {
      mediaListeners.delete(listener as () => void)
    }),
  }
  const events = {
    addEventListener: vi.fn((_event: string, listener: unknown) => {
      storageListeners.add(listener as (event: StorageEvent) => void)
    }),
    removeEventListener: vi.fn((_event: string, listener: unknown) => {
      storageListeners.delete(listener as (event: StorageEvent) => void)
    }),
  }
  const create = () => new ThemeController({ root, storage, media, events })
  return {
    root,
    storage,
    media,
    create,
    systemChange: (dark: boolean) => {
      media.matches = dark
      mediaListeners.forEach((listener) => listener())
    },
    storageChange: (value: string | null, key: string | null = THEME_STORAGE_KEY) => {
      storageListeners.forEach((listener) =>
        listener({ key, newValue: value, storageArea: null } as StorageEvent),
      )
    },
  }
}

describe('appearance preferences', () => {
  it('resolves stored overrides before applying the shared app and grid mode', () => {
    const { create, root, storage, systemChange } = setup('dark')
    const controller = create()
    expect(root.dataset).toEqual({ theme: 'dark', agThemeMode: 'dark', themePreference: 'dark' })
    expect(root.style.colorScheme).toBe('dark')
    systemChange(false)
    expect(controller.store.getState()).toEqual({ preference: 'dark', resolved: 'dark' })
    controller.setPreference('light')
    expect(root.dataset.theme).toBe('light')
    expect(storage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, 'light')
    controller.dispose()
  })

  it('follows system changes only when System is selected and cleans up subscriptions', () => {
    const { create, root, systemChange, media } = setup('invalid', true)
    const controller = create()
    expect(controller.store.getState()).toEqual({ preference: 'system', resolved: 'dark' })
    systemChange(false)
    expect(root.dataset.theme).toBe('light')
    controller.setPreference('dark')
    systemChange(false)
    expect(root.dataset.theme).toBe('dark')
    controller.setPreference('system')
    expect(root.dataset.theme).toBe('light')
    controller.dispose()
    systemChange(true)
    expect(root.dataset.theme).toBe('light')
    expect(media.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('updates other tabs and returns to system mode when storage is cleared', () => {
    const { create, root, storageChange } = setup(null, true)
    const controller = create()
    storageChange('light')
    expect(root.dataset.theme).toBe('light')
    storageChange('dark', 'unrelated')
    expect(root.dataset.theme).toBe('light')
    storageChange(null, null)
    expect(root.dataset.theme).toBe('dark')
    expect(controller.store.getState().preference).toBe('system')
    controller.dispose()
    storageChange('light')
    expect(root.dataset.theme).toBe('dark')
  })

  it('continues to work when preference reads and writes are blocked', () => {
    const { create, root, storage } = setup(null, true)
    storage.getItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    storage.setItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    const controller = create()
    expect(root.dataset.theme).toBe('dark')
    expect(() => controller.setPreference('light')).not.toThrow()
    expect(root.dataset.theme).toBe('light')
    controller.dispose()
  })
})
