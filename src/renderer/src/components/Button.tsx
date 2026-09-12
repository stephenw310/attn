import type { ButtonHTMLAttributes } from 'react'

export function Button({
  className = '',
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`app-button ${variant === 'primary' ? 'app-button-primary' : ''} ${className}`}
    />
  )
}
