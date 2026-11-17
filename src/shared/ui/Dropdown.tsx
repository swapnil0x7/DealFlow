import * as Select from '@radix-ui/react-select'
import type { ReactElement, Ref } from 'react'
import styles from './Dropdown.module.css'

export interface DropdownOption<Value extends string = string> {
  value: Value
  label: string
  disabled?: boolean
}

interface DropdownProps<Value extends string> {
  id?: string
  'aria-label': string
  value: Value
  options: readonly DropdownOption<Value>[]
  onValueChange: (value: Value) => void
  disabled?: boolean
  className?: string
  size?: 'default' | 'filter'
  trigger?: ReactElement
  triggerRef?: Ref<HTMLButtonElement>
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  popupClassName?: string
  popupMinWidth?: number
  onCloseAutoFocus?: (event: Event) => void
}

export function Dropdown<Value extends string>({
  id,
  'aria-label': label,
  value,
  options,
  onValueChange,
  disabled,
  className,
  size = 'default',
  trigger,
  triggerRef,
  defaultOpen,
  onOpenChange,
  popupClassName,
  popupMinWidth,
  onCloseAutoFocus,
}: DropdownProps<Value>) {
  // Radix reserves the empty string for a placeholder; our filters use it for “All”.
  const key = (option: string) => `value:${option}`
  return (
    <Select.Root
      value={key(value)}
      disabled={disabled}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      onValueChange={(next) => {
        const option = options.find((item) => key(item.value) === next)
        if (option && !option.disabled) onValueChange(option.value)
      }}
    >
      <Select.Trigger
        ref={triggerRef}
        asChild={Boolean(trigger)}
        id={id}
        data-size={size}
        aria-label={label}
        className={trigger ? className : `${styles.trigger} ${className ?? ''}`}
      >
        {trigger ?? (
          <>
            <span className={styles.value}>
              <Select.Value />
            </span>
            <Select.Icon className={styles.chevron}>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m3.5 6 4.5 4.5L12.5 6" />
              </svg>
            </Select.Icon>
          </>
        )}
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          data-motion="popover"
          className={`${styles.menu} ${popupClassName ?? ''}`}
          style={
            popupMinWidth
              ? { minWidth: `max(${popupMinWidth}px, var(--radix-select-trigger-width))` }
              : undefined
          }
          onCloseAutoFocus={onCloseAutoFocus}
          position="popper"
          sideOffset={6}
          align="start"
          collisionPadding={12}
        >
          <Select.Viewport className={styles.viewport}>
            {options.map((option) => (
              <Select.Item
                className={styles.option}
                key={option.value}
                value={key(option.value)}
                disabled={option.disabled}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className={styles.check}>
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="m3 8 3.25 3.25L13 4.5" />
                  </svg>
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
