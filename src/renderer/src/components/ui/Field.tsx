import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Checkbox as RCheckbox, Select as RSelect, Switch as RSwitch } from 'radix-ui'
import { cn } from '@/lib/cn'

export const inputClass =
  'h-10 w-full rounded-xl border border-line-strong/80 bg-field px-3.5 text-sm text-fg shadow-[inset_0_1px_2px_rgb(10_31_20/0.035)] placeholder:text-fg-4 transition-[border-color,box-shadow] outline-none hover:border-line-strong focus:border-forest-700 focus:ring-1 focus:ring-forest-700 disabled:opacity-50 aria-[invalid=true]:border-claret-500 aria-[invalid=true]:ring-claret-500'

export function FieldShell({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  aside
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: string | null
  htmlFor?: string
  children: ReactNode
  className?: string
  aside?: ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || aside) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="text-[13px] font-semibold text-fg-2">
              {label}
            </label>
          )}
          {aside}
        </div>
      )}
      {children}
      {error ? (
        <p className="text-xs font-medium text-claret-700">{error}</p>
      ) : hint ? (
        <p className="text-xs text-fg-4">{hint}</p>
      ) : null}
    </div>
  )
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: ReactNode
  hint?: ReactNode
  error?: string | null
  prefix?: ReactNode
  suffix?: ReactNode
  containerClassName?: string
  /** Shown at the right of the label row (e.g. a unit switch). */
  aside?: ReactNode
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, prefix, suffix, className, containerClassName, aside, id, ...rest },
  ref
) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={inputId} className={containerClassName} aside={aside}>
      <div className="relative flex items-center">
        {prefix && <span className="pointer-events-none absolute left-3.5 text-sm text-fg-4">{prefix}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={cn(inputClass, prefix ? 'pl-12' : '', suffix ? 'pr-12' : '', className)}
          {...rest}
        />
        {suffix && <span className="absolute right-3 text-sm text-fg-4">{suffix}</span>}
      </div>
    </FieldShell>
  )
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }>(
  function TextArea({ label, className, id, ...rest }, ref) {
    const autoId = useId()
    return (
      <FieldShell label={label} htmlFor={id ?? autoId}>
        <textarea ref={ref} id={id ?? autoId} className={cn(inputClass, 'h-auto min-h-20 py-2.5', className)} {...rest} />
      </FieldShell>
    )
  }
)

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
  hint?: ReactNode
}

export function Select<V extends string>({
  value,
  onChange,
  options,
  label,
  placeholder = 'Choose…',
  disabled,
  className,
  error
}: {
  value: V | null
  onChange: (value: V) => void
  options: SelectOption<V>[]
  label?: ReactNode
  placeholder?: string
  disabled?: boolean
  className?: string
  error?: string | null
}) {
  const id = useId()
  return (
    <FieldShell label={label} htmlFor={id} className={className} error={error}>
      <RSelect.Root value={value ?? undefined} onValueChange={(v) => onChange(v as V)} disabled={disabled}>
        <RSelect.Trigger id={id} className={cn(inputClass, 'flex items-center justify-between gap-2 text-left data-[placeholder]:text-fg-4')}>
          <RSelect.Value placeholder={placeholder} />
          <RSelect.Icon>
            <ChevronDown className="size-4 text-fg-4" />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content
            position="popper"
            sideOffset={6}
            className="z-[90] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] popover overflow-hidden p-1"
          >
            <RSelect.Viewport>
              {options.map((o) => (
                <RSelect.Item
                  key={o.value}
                  value={o.value}
                  className="relative flex cursor-pointer items-center justify-between gap-3 rounded-lg py-2 pr-8 pl-3 text-sm text-fg outline-none select-none data-[highlighted]:bg-forest-950/[0.06] data-[state=checked]:font-semibold data-[state=checked]:text-forest-700"
                >
                  <div className="flex flex-col">
                    <RSelect.ItemText>{o.label}</RSelect.ItemText>
                    {o.hint && <span className="text-xs text-fg-4">{o.hint}</span>}
                  </div>
                  <RSelect.ItemIndicator className="absolute right-2.5">
                    <Check className="size-4" />
                  </RSelect.ItemIndicator>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </FieldShell>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">{label}</span>
        {description && <span className="text-xs text-fg-4">{description}</span>}
      </label>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative mt-0.5 h-6 w-10 shrink-0 rounded-full border border-line-strong bg-sunken-2 transition-colors data-[state=checked]:border-forest-700 data-[state=checked]:bg-forest-700 disabled:opacity-50"
      >
        <RSwitch.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(10_31_20/0.2)] transition-transform duration-200 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-cream" />
      </RSwitch.Root>
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <RCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-line-strong bg-field transition-colors data-[state=checked]:border-forest-700 data-[state=checked]:bg-forest-700 disabled:opacity-50"
      >
        <RCheckbox.Indicator>
          <Check className="size-3.5 text-cream" strokeWidth={3} />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">{label}</span>
        {description && <span className="text-xs text-fg-4">{description}</span>}
      </label>
    </div>
  )
}

/** Parses a money/number input; returns null for empty or invalid text. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim()
  if (cleaned === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Number(cleaned)
}

/** A rate per minute: up to four decimals (e.g. 6.6667), above zero, at most 10,000. */
export function parseRate(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim()
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return n > 0 && n <= 10_000 ? n : null
}

export function parseIntStrict(text: string): number | null {
  const cleaned = text.trim()
  if (!/^-?\d+$/.test(cleaned)) return null
  return Number(cleaned)
}
