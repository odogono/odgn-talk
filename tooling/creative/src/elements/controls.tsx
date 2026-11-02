/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// Info's form controls, shared by the panel and each Element kind's section.
// Every control names its field with `data-field`; the Stack commits it.
import type { ComponentChildren } from 'preact';

const FONTS = [
  'system-ui, sans-serif',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
];

export const field = (label: string, control: ComponentChildren) => (
  <label className="field">
    <span>{label}</span>
    {control}
  </label>
);

export const fontField = (font: string, disabled: boolean) =>
  field(
    'Font',
    <select data-field="font" disabled={disabled} value={font}>
      {(FONTS.includes(font) ? FONTS : [font, ...FONTS]).map(value => (
        <option key={value} value={value}>
          {value}
        </option>
      ))}
    </select>,
  );

export const input = (
  name: string,
  value: string | number,
  disabled: boolean,
  type: 'text' | 'number' | 'color' = 'text',
  extra: { min?: number; placeholder?: string } = {},
) => {
  const props = { 'data-field': name, value, disabled, ...extra };
  // Preact's accessible input types require a literal input type per branch.
  switch (type) {
    case 'number':
      return <input type="number" {...props} />;
    case 'color':
      return <input type="color" {...props} />;
    default:
      return <input type="text" {...props} />;
  }
};

export const color = (name: string, value: string, disabled: boolean) =>
  input(
    name,
    /^#[0-9a-f]{6}$/iu.test(value) ? value : '#000000',
    disabled,
    'color',
  );

export const checkbox = (
  name: string,
  label: string,
  checked: boolean,
  disabled: boolean,
) => (
  <label className="check">
    <input
      checked={checked}
      data-field={name}
      disabled={disabled}
      type="checkbox"
    />
    {label}
  </label>
);

/** A labelled choice from `options`, each shown by its label. */
export const select = <T extends string>(
  name: string,
  value: T,
  disabled: boolean,
  options: readonly T[],
  labels: Readonly<Record<T, string>>,
) => (
  <select data-field={name} disabled={disabled} value={value}>
    {options.map(option => (
      <option key={option} value={option}>
        {labels[option]}
      </option>
    ))}
  </select>
);

export const controls = { field, fontField, input, color, checkbox, select };
export type InfoControls = typeof controls;
