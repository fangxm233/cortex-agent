// input:  Radix Select, controlled typed options and trigger attributes
// output: accessible profile-styled single-value selection control
// pos:    Shared custom dropdown primitive for desktop form fields
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
}

const TRIGGER_CLASS =
  'inline-flex items-center justify-between gap-1g text-left outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-proto-accent/40 disabled:cursor-not-allowed';

const CONTENT_CLASS =
  'z-[100] overflow-hidden rounded-menu border border-proto-line bg-proto-card ' +
  'font-mono text-[10px] text-proto-ink shadow-menu ' +
  'data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out ' +
  'motion-reduce:animate-none';

const ITEM_CLASS =
  'relative flex w-full select-none items-center gap-0.5g px-1g py-menu-row-y pr-3g outline-none ' +
  'font-semibold leading-[normal] ' +
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
  compact: { ...DENSITY_FONT, padding: '2px 7px', borderRadius: 6 },
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
        <span className="text-[9px] font-normal text-proto-muted-3">{option.description}</span>
      ) : null}
      <RadixSelect.ItemIndicator className="absolute right-1g text-[9px] font-bold text-proto-accent">
        ✓
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

function SelectPopup<T extends SelectValue>({
  options,
}: {
  options: readonly SelectOption<T>[];
}): JSX.Element {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content position="popper" sideOffset={4} align="start" className={CONTENT_CLASS} style={CONTENT_STYLE}>
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

export function Select<T extends SelectValue>({
  value,
  options,
  onValueChange,
  placeholder = '',
  density = 'compact',
  className,
  style,
  disabled,
  ...triggerProps
}: SelectProps<T>): JSX.Element {
  const selectedIndex = optionIndex(options, value);
  const selected = options[selectedIndex];
  const rootValue = selectedIndex < 0 ? 'selection-unset' : optionKey(selectedIndex);
  return (
    <RadixSelect.Root
      value={rootValue}
      disabled={disabled}
      onValueChange={(key) => selectByKey(key, options, onValueChange)}
    >
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
      <SelectPopup options={options} />
    </RadixSelect.Root>
  );
}
