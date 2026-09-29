//
// Renders per M4 spec:
//   section  → static text (dimmed)
//   select   → numbered list, ↑/↓ navigate, Enter selects
//   multi_select → numbered list with [x]/[ ] checkboxes, ↑/↓ navigate, Space toggles
//   text_input  → character capture via useInput
// On submit: builds values:Record<blockId,Record<actionId,ModalFieldValue>>
//   matching M4 modal.submit shape and sends via sendFrame.
// Displays modal.ack errors inline beneath the offending field.

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModalDefinition, ModalField, TuiFrame, ModalFieldValue } from '../../platform/tui/protocol.js';
import { t } from '../../core/i18n.js';

// ── Props ──

interface AskUserModalProps {
  modal: ModalDefinition;
  sendFrame: (frame: TuiFrame) => void;
  ackErrors: Record<string, string>;
  onClose: () => void;
}

// ── Internal state ──

interface ModalSelections {
  select: Record<string, number>;
  multiSelect: Record<string, Set<number>>;
  text: Record<string, string>;
}

// ── Field identification helpers ──

type InteractiveField = import('../../platform/types.js').ModalSelectField
  | import('../../platform/types.js').ModalMultiSelectField
  | import('../../platform/types.js').ModalTextInputField;

/** Return all interactive elements for focus navigation. */
function getInteractiveFields(fields: ModalField[]): Array<{ field: InteractiveField; fieldIdx: number }> {
  const result: Array<{ field: InteractiveField; fieldIdx: number }> = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.type === 'select' || f.type === 'multi_select' || f.type === 'text_input') {
      result.push({ field: f as InteractiveField, fieldIdx: i });
    }
  }
  return result;
}

// ── Component ──

export function AskUserModal({
  modal,
  sendFrame,
  ackErrors,
  onClose,
}: AskUserModalProps): React.JSX.Element {
  // Pre-compute interactive fields for focus initialization (pure function, called before hooks)
  const initInteractiveFields = getInteractiveFields(modal.fields);

  // ── Focus state: start on the first interactive field ──
  const [fieldFocus, setFieldFocus] = useState(
    initInteractiveFields.length > 0 ? initInteractiveFields[0].fieldIdx : -1
  );
  const [optionFocus, setOptionFocus] = useState(0);
  const [selections, setSelections] = useState<ModalSelections>({
    select: {},
    multiSelect: {},
    text: {},
  });

  const [submitted, setSubmitted] = useState(false);

  // Reset submitted when ack errors arrive — user can fix and resubmit
  useEffect(() => {
    if (Object.keys(ackErrors).length > 0) {
      setSubmitted(false);
    }
  }, [ackErrors]);

  const optionFocusRef = useRef(optionFocus);
  optionFocusRef.current = optionFocus;

  const interactiveFields = useMemo(() => getInteractiveFields(modal.fields), [modal.fields]);
  const submitLabel = modal.submitLabel || t('tui.modal.submit');

  // --- Build a flat list of keyboard focusable slots ---
  // Each slot is either:
  //   { kind: 'field', fieldIdx, optionIdx }  — an option within a select/multi_select
  //   { kind: 'text', fieldIdx }               — a text_input field
  //   { kind: 'submit' }                       — the submit button
  // Only expand select/multi_select options when the field is focused.

  // Focus slot building
  type FocusSlot =
    | { kind: 'field-option'; fieldIdx: number; optionIdx: number }
    | { kind: 'text-field'; fieldIdx: number }
    | { kind: 'submit' };

  function buildFocusSlots(): FocusSlot[] {
    const slots: FocusSlot[] = [];
    for (const ifield of interactiveFields) {
      const fi = ifield.fieldIdx;
      if (ifield.field.type === 'select' || ifield.field.type === 'multi_select') {
        for (let oi = 0; oi < ifield.field.options.length; oi++) {
          slots.push({ kind: 'field-option', fieldIdx: fi, optionIdx: oi });
        }
      } else if (ifield.field.type === 'text_input') {
        slots.push({ kind: 'text-field', fieldIdx: fi });
      }
    }
    slots.push({ kind: 'submit' });
    return slots;
  }

  // Only resolve slots when fieldFocus corresponds to an interactive field
  const slots = buildFocusSlots();
  const currentSlotIndexRef = useRef(0);

  /** Find the next slot that belongs to a different interactive field (or submit).
   *  Used by Enter to move to the next field after confirming a select/multi/text. */
  function findNextFieldSlot(currentFieldIdx: number): FocusSlot | null {
    const currentSlot = currentSlotIndexRef.current;
    for (let i = currentSlot + 1; i < slots.length; i++) {
      const s = slots[i];
      if (s.kind === 'submit') return s;
      if (s.kind === 'field-option' && s.fieldIdx !== currentFieldIdx) return s;
      if (s.kind === 'text-field' && s.fieldIdx !== currentFieldIdx) return s;
    }
    // No next field found — return submit
    return slots[slots.length - 1]?.kind === 'submit' ? slots[slots.length - 1] : null;
  }

  // Map focus state to slot index
  useEffect(() => {
    if (fieldFocus === -1) {
      currentSlotIndexRef.current = slots.length - 1; // submit
    } else {
      const idx = slots.findIndex(s =>
        (s.kind === 'field-option' && s.fieldIdx === fieldFocus && s.optionIdx === optionFocus) ||
        (s.kind === 'text-field' && s.fieldIdx === fieldFocus)
      );
      if (idx >= 0) currentSlotIndexRef.current = idx;
      else if (slots.length > 0) currentSlotIndexRef.current = 0;
    }
  }, [fieldFocus, optionFocus, slots]);

  // ── Keyboard handling ──

  const handleClose = useCallback(() => {
    if (!submitted) {
      onClose();
    }
  }, [submitted, onClose]);

  const handleSubmit = useCallback(() => {
    if (submitted) return;
    setSubmitted(true);

    const values: Record<string, Record<string, ModalFieldValue>> = {};
    for (const f of modal.fields) {
      if (f.type === 'section') continue;
      if (f.type === 'select') {
        const idx = selections.select[f.blockId];
        if (idx !== undefined && f.options[idx]) {
          values[f.blockId] = {
            [f.actionId]: { selectedOption: { value: f.options[idx].value } },
          };
        }
      }
      if (f.type === 'multi_select') {
        const toggled = selections.multiSelect[f.blockId];
        if (toggled && toggled.size > 0) {
          values[f.blockId] = {
            [f.actionId]: {
              selectedOptions: [...toggled].map(i => ({ value: f.options[i].value })),
            },
          };
        }
      }
      if (f.type === 'text_input') {
        const val = selections.text[f.blockId];
        if (val !== undefined && val !== '') {
          values[f.blockId] = { [f.actionId]: { value: val } };
        }
      }
    }

    sendFrame({
      type: 'modal.submit',
      id: `modal-submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      callbackId: modal.callbackId,
      privateMetadata: modal.privateMetadata || '',
      values,
      userId: 'tui',
    } as TuiFrame);
  }, [submitted, modal, selections, sendFrame]);

  useInput((input, key) => {
    // Esc always closes (if not submitted yet)
    if (key.escape) {
      handleClose();
      return;
    }

    if (submitted) return;

    if (key.return) {
      // If submit button is focused, submit
      if (fieldFocus === -1) {
        handleSubmit();
        return;
      }
      // If on a select option, confirm selection and move to next slot
      const currentField = interactiveFields.find(ifd => ifd.fieldIdx === fieldFocus);
      if (currentField) {
        const cf = currentField.field;
        if (cf.type === 'select') {
          // Confirm selection and move to next FIELD (skip remaining options)
          setSelections(prev => ({
            ...prev,
            select: { ...prev.select, [cf.blockId]: optionFocus },
          }));
          const nextField = findNextFieldSlot(fieldFocus);
          if (nextField) {
            if (nextField.kind === 'field-option') {
              setFieldFocus(nextField.fieldIdx);
              setOptionFocus(nextField.optionIdx);
            } else if (nextField.kind === 'text-field') {
              setFieldFocus(nextField.fieldIdx);
            } else if (nextField.kind === 'submit') {
              setFieldFocus(-1);
            }
          } else {
            setFieldFocus(-1);
          }
          return;
        }
        if (cf.type === 'multi_select') {
          // Confirm multi selections — move to next FIELD
          const nextField = findNextFieldSlot(fieldFocus);
          if (nextField) {
            if (nextField.kind === 'field-option') {
              setFieldFocus(nextField.fieldIdx);
              setOptionFocus(nextField.optionIdx);
            } else if (nextField.kind === 'text-field') {
              setFieldFocus(nextField.fieldIdx);
            } else if (nextField.kind === 'submit') {
              setFieldFocus(-1);
            }
          } else {
            setFieldFocus(-1);
          }
          return;
        }
        if (cf.type === 'text_input') {
          // Enter on text_input: move to next field
          const nextField = findNextFieldSlot(fieldFocus);
          if (nextField) {
            if (nextField.kind === 'field-option') {
              setFieldFocus(nextField.fieldIdx);
              setOptionFocus(nextField.optionIdx);
            } else if (nextField.kind === 'text-field') {
              setFieldFocus(nextField.fieldIdx);
            } else if (nextField.kind === 'submit') {
              setFieldFocus(-1);
            }
          } else {
            setFieldFocus(-1);
          }
          return;
        }
      }

      // Default: move to submit
      setFieldFocus(-1);
      return;
    }

    // Arrow key navigation between slots
    if (key.upArrow || key.downArrow) {
      const currSlot = currentSlotIndexRef.current;
      let nextIdx: number | null = null;
      if (key.downArrow && currSlot < slots.length - 1) {
        nextIdx = currSlot + 1;
      } else if (key.upArrow && currSlot > 0) {
        nextIdx = currSlot - 1;
      }
      if (nextIdx !== null) {
        const next = slots[nextIdx];
        if (next.kind === 'field-option') {
          setFieldFocus(next.fieldIdx);
          setOptionFocus(next.optionIdx);
        } else if (next.kind === 'text-field') {
          setFieldFocus(next.fieldIdx);
        } else if (next.kind === 'submit') {
          setFieldFocus(-1);
        }
      }
      return;
    }

    // Space toggles multi_select option
    if (input === ' ' && !key.ctrl && !key.meta && !key.shift) {
      const currentField = interactiveFields.find(ifd => ifd.fieldIdx === fieldFocus);
      if (currentField && currentField.field.type === 'multi_select') {
        const cf = currentField.field;
        setSelections(prev => {
          const current = new Set(prev.multiSelect[cf.blockId] || []);
          if (current.has(optionFocus)) {
            current.delete(optionFocus);
          } else {
            current.add(optionFocus);
          }
          return { ...prev, multiSelect: { ...prev.multiSelect, [cf.blockId]: current } };
        });
      }
      return;
    }

    // Number keys for select/multi_select
    if (/^[1-9]$/.test(input)) {
      const currentField = interactiveFields.find(ifd => ifd.fieldIdx === fieldFocus);
      if (currentField && (currentField.field.type === 'select' || currentField.field.type === 'multi_select')) {
        const cf = currentField.field as typeof currentField.field & { options: Array<{ label: string; value: string }> };
        const numIdx = parseInt(input, 10) - 1;
        if (numIdx >= 0 && numIdx < cf.options.length) {
          if (cf.type === 'multi_select') {
            setSelections(prev => {
              const current = new Set(prev.multiSelect[cf.blockId] || []);
              if (current.has(numIdx)) {
                current.delete(numIdx);
              } else {
                current.add(numIdx);
              }
              return { ...prev, multiSelect: { ...prev.multiSelect, [cf.blockId]: current } };
            });
          } else if (cf.type === 'select') {
            setSelections(prev => ({
              ...prev,
              select: { ...prev.select, [cf.blockId]: numIdx },
            }));
            setOptionFocus(numIdx);
          }
        }
      }
      return;
    }

    // Character capture for text_input
    const currentField = interactiveFields.find(ifd => ifd.fieldIdx === fieldFocus);
    if (currentField && currentField.field.type === 'text_input') {
      const cf = currentField.field;
      if (key.backspace || key.delete) {
        setSelections(prev => {
          const current = prev.text[cf.blockId] || '';
          return { ...prev, text: { ...prev.text, [cf.blockId]: current.slice(0, -1) } };
        });
      } else if (input.length === 1 && !key.ctrl && !key.meta && !key.shift) {
        setSelections(prev => ({
          ...prev,
          text: { ...prev.text, [cf.blockId]: (prev.text[cf.blockId] || '') + input },
        }));
      }
      return;
    }
  });

  // ── Render helpers ──

  function renderField(field: ModalField, idx: number): React.JSX.Element | null {
    switch (field.type) {
      case 'section':
        return (
          <Box key={`section-${idx}`} marginTop={1}>
            <Text dimColor>{field.text}</Text>
          </Box>
        );

      case 'select': {
        const selectedIdx = selections.select[field.blockId] ?? optionFocus;
        return (
          <Box key={`field-${idx}`} flexDirection="column" marginTop={1}>
            <Text bold={fieldFocus === idx} dimColor={fieldFocus !== idx}>
              {field.label}
            </Text>
            {field.options.map((opt, oi) => {
              const isFocused = fieldFocus === idx && optionFocus === oi;
              const isSelected = selections.select[field.blockId] === oi;
              const prefix = isFocused ? '▶' : isSelected ? '●' : '○';
              return (
                <Box key={oi} marginLeft={2}>
                  <Text bold={isFocused} color={isSelected ? 'green' : undefined}>
                    {prefix} {oi + 1}. {opt.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      }

      case 'multi_select': {
        return (
          <Box key={`field-${idx}`} flexDirection="column" marginTop={1}>
            <Text bold={fieldFocus === idx} dimColor={fieldFocus !== idx}>
              {field.label}
            </Text>
            {field.options.map((opt, oi) => {
              const isFocused = fieldFocus === idx && optionFocus === oi;
              const isSelected = selections.multiSelect[field.blockId]?.has(oi) ?? false;
              return (
                <Box key={oi} marginLeft={2}>
                  <Text bold={isFocused}>
                    {isFocused ? '▶' : ' '} [{isSelected ? 'x' : ' '}] {oi + 1}. {opt.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      }

      case 'text_input': {
        const val = selections.text[field.blockId] || '';
        return (
          <Box key={`field-${idx}`} flexDirection="column" marginTop={1}>
            <Text bold={fieldFocus === idx} dimColor={fieldFocus !== idx}>
              {field.label}
            </Text>
            <Box
              borderStyle="single"
              borderDimColor={fieldFocus !== idx}
              paddingX={1}
              marginLeft={2}
            >
              {val ? (
                <Text>{val}</Text>
              ) : (
                <Text dimColor>{field.placeholder || t('tui.modal.typeHere')}</Text>
              )}
            </Box>
          </Box>
        );
      }

      default:
        return null;
    }
  }

  // ── Render ──

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="single">
      {/* Title */}
      <Text bold>{modal.title}</Text>
      {modal.fields.map((field, idx) => renderField(field, idx))}

      {/* Ack errors */}
      {Object.keys(ackErrors).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {Object.entries(ackErrors).map(([blockId, errorMsg]) => {
            const found = modal.fields.find(
              (f): f is InteractiveField =>
                (f.type === 'select' || f.type === 'multi_select' || f.type === 'text_input') &&
                f.blockId === blockId
            );
            const label = found?.label ?? blockId;
            return (
              <Box key={`err-${blockId}`}>
                <Text color="red">⚠ {label}: {errorMsg}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {/* Submit button */}
      <Box marginTop={1}>
        <Text bold={fieldFocus === -1} dimColor={fieldFocus !== -1}>
          {fieldFocus === -1 ? '▶' : ' '} [{submitLabel}]
        </Text>
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          {fieldFocus === -1
            ? t('tui.modal.hintSubmit')
            : t('tui.modal.hintSelect')}
        </Text>
      </Box>
    </Box>
  );
}
