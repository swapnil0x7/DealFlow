import { useStore } from 'zustand'
import { Dropdown } from '../../shared/ui/Dropdown'
import { getThemeController } from './browser'
import type { ThemePreference } from './controller'
import styles from './ThemeSwitcher.module.css'

const options = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] satisfies { value: ThemePreference; label: string }[]

export function ThemeSwitcher() {
  const controller = getThemeController()
  const { preference, resolved } = useStore(controller.store)
  const label = options.find((option) => option.value === preference)!.label
  return (
    <Dropdown
      aria-label="Appearance"
      value={preference}
      options={options}
      onValueChange={controller.setPreference}
      trigger={
        <button
          className={styles.trigger}
          type="button"
          title={`Appearance: ${label} (${resolved})`}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            {preference === 'system' ? (
              <>
                <rect x="2.5" y="3.5" width="15" height="10" rx="2" />
                <path d="M7 17h6m-3-3.5V17" />
              </>
            ) : preference === 'dark' ? (
              <path d="M16.6 12.1A7 7 0 0 1 7.9 3.4a7 7 0 1 0 8.7 8.7Z" />
            ) : (
              <>
                <circle cx="10" cy="10" r="3.5" />
                <path d="M10 1.5v1m0 15v1M1.5 10h1m15 0h1M4 4l.8.8m10.4 10.4.8.8M4 16l.8-.8M15.2 4.8 16 4" />
              </>
            )}
          </svg>
          <span>{label}</span>
          <svg className={styles.chevron} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      }
    />
  )
}
