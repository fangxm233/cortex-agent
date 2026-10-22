import { useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { MBottomSheet } from './BottomSheet';
import { MC } from './mobile-tokens';

export interface MSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface MSelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  value: string;
  options: readonly MSelectOption[];
  onValueChange: (value: string) => void;
  title: string;
  placeholder?: string;
  /** Scope classes must follow the field into the portaled picker. */
  sheetClassName?: string;
}

const FIELD: CSSProperties = {
  width: '100%', minWidth: 0, minHeight: 44, boxSizing: 'border-box',
  border: `1px solid ${MC.hairline}`, borderRadius: 8, background: 'var(--material-inset-bg)',
  color: MC.ink, padding: '8px 12px', fontSize: 16, fontFamily: 'inherit',
  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
};
const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const ROW: CSSProperties = {
  width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 13px', border: 0, background: 'transparent', textAlign: 'left', fontFamily: 'inherit', color: MC.ink,
};

function invalidBorder(invalid: MSelectProps['aria-invalid']) {
  return invalid && invalid !== 'false' ? MC.failBorder : undefined;
}

function fieldStyle(disabled: boolean | undefined, invalid: MSelectProps['aria-invalid'], style?: CSSProperties): CSSProperties {
  return { ...FIELD, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    ...style, borderColor: invalidBorder(invalid) ?? style?.borderColor };
}

function rowStyle(disabled: boolean | undefined, last: boolean): CSSProperties {
  return { ...ROW, borderBottom: last ? undefined : '1px solid var(--proto-line-soft)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1 };
}

function OptionCopy({ option, selected }: { option: MSelectOption; selected: boolean }) {
  return <span style={{ minWidth: 0, flex: 1 }}>
    <span style={{ ...ELLIPSIS, display: 'block', fontSize: 15, fontWeight: selected ? 600 : 500 }}>{option.label}</span>
    {option.description && <span style={{ display: 'block', fontSize: 12.5, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' }}>{option.description}</span>}
  </span>;
}

function OptionRow({ option, selected, last, autoFocus, onPick }: {
  option: MSelectOption; selected: boolean; last: boolean; autoFocus: boolean; onPick: () => void;
}) {
  return <button type="button" role="radio" aria-checked={selected} disabled={option.disabled}
    autoFocus={autoFocus} data-m-select-option={option.value}
    onClick={() => { if (!option.disabled) onPick(); }}
    style={rowStyle(option.disabled, last)}>
    <OptionCopy option={option} selected={selected} />
    {selected && <span aria-hidden="true" style={{ fontSize: 15, fontWeight: 700, flex: 'none' }}>✓</span>}
  </button>;
}

function Picker({ id, title, options, value, className, onClose, onPick }: {
  id: string; title: string; options: readonly MSelectOption[]; value: string;
  className?: string; onClose: () => void; onPick: (value: string) => void;
}) {
  const focusValue = options.find(option => option.value === value && !option.disabled)?.value
    ?? options.find(option => !option.disabled)?.value;
  return <MBottomSheet onClose={onClose} className={className}>
    <section id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onClick={event => event.stopPropagation()}>
      <h2 id={`${id}-title`} style={{ margin: 0, fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 10px' }}>{title}</h2>
      <div role="radiogroup" aria-label={title} style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
        {options.map((option, index) => <OptionRow key={option.value} option={option}
          selected={option.value === value} last={index === options.length - 1}
          autoFocus={option.value === focusValue} onPick={() => onPick(option.value)} />)}
      </div>
    </section>
  </MBottomSheet>;
}

export function MSelect({ value, options, onValueChange, title, placeholder, disabled, style, sheetClassName, ...button }: MSelectProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find(option => option.value === value);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const pick = (next: string) => { close(); onValueChange(next); };
  return <>
    <button {...button} ref={trigger} type="button" title={title} disabled={disabled}
      aria-label={button['aria-label'] ?? title} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { button.onClick?.(event); if (!disabled && !event.defaultPrevented) setOpen(true); }}
      style={fieldStyle(disabled, button['aria-invalid'], style)}>
      <span style={{ ...ELLIPSIS, flex: 1, color: selected ? undefined : MC.muted }}>{selected?.label ?? placeholder ?? value}</span>
      <span aria-hidden="true" style={{ color: MC.muted, flex: 'none' }}>▾</span>
    </button>
    {open && !disabled && <Picker id={id} title={title} value={value} options={options} className={sheetClassName}
      onClose={close} onPick={pick} />}
  </>;
}
