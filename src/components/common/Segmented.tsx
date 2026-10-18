// The two switcher primitives. Both render buttons whose state lives in `aria-selected`, so
// there is a single selector for "the current one" instead of a class per component.
//   Segmented — a pill, for switching how the same content is shown (Table/Notes, Day/Week).
//   Tabs      — an underline, for switching between panels of different content.

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}

function Switcher<T extends string>({ base, options, value, onChange, label, className }: Props<T> & { base: string }) {
  return (
    <div className={`${base}${className ? ` ${className}` : ''}`} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>(props: Props<T>) {
  return <Switcher base="seg" {...props} />;
}

export function Tabs<T extends string>(props: Props<T> & { fill?: boolean }) {
  const { fill, className, ...rest } = props;
  return <Switcher base="tabs" {...rest} className={`${fill ? 'fill' : ''}${className ? ` ${className}` : ''}`.trim() || undefined} />;
}
