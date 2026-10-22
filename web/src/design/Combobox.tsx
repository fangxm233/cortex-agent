import * as Popover from '@radix-ui/react-popover';
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { SELECT_ITEM_CLASS, SELECT_POPUP_CLASS } from './Select';
import { markSelectOutsideInteraction } from './select-outside-interaction';

export interface ComboboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> {
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
  popupClassName?: string;
}

function suggestions(options: readonly string[], value: string): string[] {
  const query = value.toLowerCase();
  const unique = [...new Set(options)];
  if (!query || unique.some(option => option.toLowerCase() === query)) return unique;
  return unique.filter(option => option.toLowerCase().includes(query));
}

function preventFocus(event: Event) { event.preventDefault(); }

function useComboboxState({ value, options, onValueChange, disabled }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const items = suggestions(options, value);
  const show = (next: boolean) => { setOpen(next && !disabled); setActive(-1); };
  const change = (next: string) => { onValueChange(next); show(true); };
  const pick = (next: string) => { onValueChange(next); input.current?.focus(); show(false); };
  const move = (step: number) => {
    if (disabled) return;
    setOpen(true);
    if (items.length) setActive(index => (index + step + items.length) % items.length);
  };
  // Radix dispatches Escape only to the top dismissable layer. Prevent its default dismissal
  // before closing explicitly so an enclosing Modal cannot consume the same key.
  const escape = (event: Event) => { event.preventDefault(); show(false); };
  return { open: open && !disabled, active, items, input, show, change, pick, move, escape };
}

type ComboboxState = ReturnType<typeof useComboboxState>;

function handleKey(event: KeyboardEvent<HTMLInputElement>, state: ComboboxState) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const actions: Record<string, () => void> = {
    ArrowDown: () => state.move(1),
    ArrowUp: () => state.move(state.active < 0 ? 0 : -1),
  };
  if (state.open && state.items[state.active] !== undefined) actions.Enter = () => state.pick(state.items[state.active]);
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function ComboboxOption({ value, id, active, pick }: {
  value: string; id: string; active: boolean; pick: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return <div ref={ref} id={id} role="option" aria-selected={active} data-highlighted={active ? '' : undefined}
    className={SELECT_ITEM_CLASS} onPointerDown={event => event.preventDefault()} onClick={() => pick(value)}>
    {value}
  </div>;
}

function ComboboxPopup({ state, id, className = '', label, labelledBy }: {
  state: ComboboxState; id: string; className?: string; label?: string; labelledBy?: string;
}) {
  return <Popover.Portal>
    <Popover.Content id={id} role="listbox" aria-label={label} aria-labelledby={labelledBy} tabIndex={-1}
      align="start" sideOffset={4} className={`${SELECT_POPUP_CLASS} ${className}`}
      style={{ minWidth: 'max(160px, var(--radix-popover-trigger-width))', overflowY: 'auto',
        maxHeight: 'min(300px, var(--radix-popover-content-available-height))' }}
      onOpenAutoFocus={preventFocus} onCloseAutoFocus={preventFocus} onEscapeKeyDown={state.escape}
      onPointerDownOutside={markSelectOutsideInteraction}
      onInteractOutside={event => { if (event.target === state.input.current) event.preventDefault(); }}>
      {state.items.map((value, index) => <ComboboxOption key={value} value={value} id={`${id}-${index}`}
        active={index === state.active} pick={state.pick} />)}
    </Popover.Content>
  </Popover.Portal>;
}

export function Combobox(props: ComboboxProps): JSX.Element {
  const { value, options: _options, onValueChange: _onValueChange, popupClassName, onFocus, onKeyDown, ...inputProps } = props;
  const state = useComboboxState(props);
  const id = useId();
  const activeId = state.open && state.items[state.active] !== undefined ? `${id}-${state.active}` : undefined;
  return <Popover.Root open={state.open} onOpenChange={state.show}>
    <Popover.Anchor asChild>
      <input autoComplete="off" {...inputProps} ref={state.input} value={value} role="combobox" aria-autocomplete="list"
        aria-haspopup="listbox" aria-expanded={state.open} aria-controls={state.open ? id : undefined}
        aria-activedescendant={activeId} onChange={event => state.change(event.target.value)}
        onFocus={event => { state.show(true); onFocus?.(event); }}
        onKeyDown={event => { onKeyDown?.(event); handleKey(event, state); }} />
    </Popover.Anchor>
    {state.open ? <ComboboxPopup state={state} id={id} className={popupClassName}
      label={props['aria-label']} labelledBy={props['aria-labelledby']} /> : null}
  </Popover.Root>;
}
