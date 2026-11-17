import type { ComponentProps } from 'react'
import styles from './Button.module.css'

type Props = ComponentProps<'button'> & { variant?: 'outline' | 'primary' | 'ghost' }

/** Feature layouts may configure button tokens while sharing native behavior and variants. */
export function Button({ type = 'button', variant = 'outline', className = '', ...props }: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.button} ${variant === 'outline' ? '' : styles[variant]} ${className}`}
    />
  )
}
