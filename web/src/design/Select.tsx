// input:  Radix Select, React, shared focus-visible styles
// output: Select, SelectProps, SelectOption
// pos:    Unblurred select controls and a glass option overlay
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixSelect from '@radix-ui/react-select';
import type { ButtonHTMLAttributes, CSSProperties } from 'react';

// Select 2.3.2 shares Dialog 1.1.18's dismissable-layer stack, so Escape closes only the top layer.
// It also strips `className`/`style` off ItemText, so the popup row size lives on the Item instead —
// the rows then read at the same size as the composer's profile menu rather than at body size.

export type SelectValue = string | number;
/**
 * `compact` is the profile-chip size, for a select that carries its own chrome. `bare` adds no
 * inline styling at all, leaving the whole box to the call site's className/style — that is how a
 * select is matched to the height of the input or button standing next to it. Either way the call
 * site's own `style` wins over the density defaults.
 */
export type SelectDensity = 'compact' | 'bare';

export interface SelectOption<T extends SelectValue> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface SelectProps<T extends SelectValue>
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange' | 'value'> {
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  placeholder?: string;
  density?: SelectDensity;
  popupClassName?: string;
}

const TRIGGER_CLASS =
  'inline-flex items-center justify-between gap-1g text-left disabled:cursor-not-allowed';

// Only the popup blurs; rows and triggers remain unfiltered. Even a stationary popup can
// resample a changing backdrop, so do not multiply that work by filtering individual rows.
const CONTENT_CLASS =
  'z-[100] overflow-hidden rounded-[var(--r-float)] [background:var(--material-overlay-bg)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'font-mono text-[12px] text-proto-ink shadow-[shadow:var(--material-overlay-shadow)] ' +
  'data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out ' +
  'motion-reduce:animate-none';

const ITEM_CLASS =
  'relative flex w-full select-none items-center gap-0.5g px-1g py-menu-row-y pr-3g ' +
  'font-medium leading-normal ' +
  'data-[highlighted]:bg-proto-gray data-[state=checked]:bg-proto-accent-bg ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40';

const CONTENT_STYLE = {
  minWidth: 'max(160px, var(--radix-select-trigger-width))',
  maxHeight: 'var(--radix-select-content-available-height)',
} as CSSProperties;

const DENSITY_FONT: CSSProperties = {
  fontFamily: "'IBM Plex Mono',monospace",
  fontSize: 10.5,
  fontWeight: 500,
  lineHeight: 1.2,
};

const DENSITY_STYLE: Record<SelectDensity, CSSProperties> = {
  // `--r-chip`, not `--r-control`: at this height the trigger is a chip, and the control radius
  // would clamp to a full pill and stop reading as a box with a value in it.
  compact: {
    ...DENSITY_FONT, padding: '2px 7px', borderRadius: 'var(--r-chip)',
    background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)',
  },
  bare: {},
};

function optionKey(index: number): string {
  return `option-${index}`;
}

function optionIndex<T extends SelectValue>(
  options: readonly SelectOption<T>[],
  value: T,
): number {
  return options.findIndex((option) => Object.is(option.value, value));
}

function selectByKey<T extends SelectValue>(
  key: string,
  options: readonly SelectOption<T>[],
  onValueChange: (value: T) => void,
): void {
  const index = Number(key.slice('option-'.length));
  const option = Number.isInteger(index) ? options[index] : undefined;
  if (option && !option.disabled) onValueChange(option.value);
}

function SelectItem<T extends SelectValue>({
  option,
  index,
}: {
  option: SelectOption<T>;
  index: number;
}): JSX.Element {
  return (
    <RadixSelect.Item
      value={optionKey(index)}
      disabled={option.disabled}
      textValue={option.label}
      title={option.disabledReason}
      className={ITEM_CLASS}
    >
      <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
      {option.description ? (
        <span className="text-[11px] font-normal text-proto-muted [overflow-wrap:anywhere]">{option.description}</span>
      ) : null}
      <RadixSelect.ItemIndicator className="absolute right-1g text-[9px] font-bold text-proto-accent">
        ✓
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

function SelectPopup<T extends SelectValue>({ options, className = '' }: {
  options: readonly SelectOption<T>[];
  className?: string;
}): JSX.Element {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content position="popper" sideOffset={4} align="start" className={`${CONTENT_CLASS} ${className}`} style={CONTENT_STYLE}>
        <RadixSelect.ScrollUpButton className="py-0.5g text-center text-proto-muted-3">▴</RadixSelect.ScrollUpButton>
        <RadixSelect.Viewport>
          {options.map((option, index) => (
            <SelectItem key={optionKey(index)} option={option} index={index} />
          ))}
        </RadixSelect.Viewport>
        <RadixSelect.ScrollDownButton className="py-0.5g text-center text-proto-muted-3">▾</RadixSelect.ScrollDownButton>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

export function Select<T extends SelectValue>({ value, options, onValueChange, placeholder = '',
  density = 'compact', className, popupClassName, style, disabled, ...triggerProps
}: SelectProps<T>): JSX.Element {
  const selectedIndex = optionIndex(options, value);
  const selected = options[selectedIndex];
  const rootValue = selectedIndex < 0 ? 'selection-unset' : optionKey(selectedIndex);
  return (
    <RadixSelect.Root value={rootValue} disabled={disabled}
      onValueChange={(key) => selectByKey(key, options, onValueChange)}>
      <RadixSelect.Trigger
        {...triggerProps}
        data-select-control
        disabled={disabled}
        className={`${TRIGGER_CLASS} ${className ?? ''}`}
        style={{ ...DENSITY_STYLE[density], ...style }}
      >
        <RadixSelect.Value>{selected?.label ?? placeholder}</RadixSelect.Value>
        <RadixSelect.Icon aria-hidden className="ml-auto text-[8px] text-proto-muted-3">▾</RadixSelect.Icon>
      </RadixSelect.Trigger>
      <SelectPopup options={options} className={popupClassName} />
    </RadixSelect.Root>
  );
}
