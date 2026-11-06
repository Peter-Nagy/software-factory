import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** A Select from a plain list of options; shows the option's label (not its value) when closed. */
export function SimpleSelect<T extends string>({ value, onChange, options, className, disabled, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  className?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <Select items={options} value={value} onValueChange={(v) => v !== null && onChange(v as T)} disabled={disabled}>
      <SelectTrigger className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
