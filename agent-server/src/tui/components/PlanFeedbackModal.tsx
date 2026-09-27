//
// Renders:
//   plan text (from section field) as a scrollable region
//   3 radio-style options: Approve (1), Provide Feedback (2), Cancel (3)
//   feedback text input (shown when feedback is selected and confirmed)
//   submit button
// Numbered hot-keys, ↑/↓ navigation, Enter to confirm, Esc to cancel.
// Builds modal.submit values matching the plan-approval server handler contract.

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModalDefinition, TuiFrame } from '../../platform/tui/protocol.js';
import { t } from '../../core/i18n.js';

// ── Props (same contract as AskUserModal) ──

interface PlanFeedbackModalProps {
  modal: ModalDefinition;
  triggerId: string;
  sendFrame: (frame: TuiFrame) => void;
  ackErrors: Record<string, string>;
  onClose: () => void;
}

// ── Option descriptors ──

interface OptionDef {
  id: 'approve' | 'feedback' | 'cancel';
  /** i18n key for the option label, resolved at render so it follows the active locale. */
  labelKey: string;
  value: string;
}

const OPTIONS: OptionDef[] = [
  { id: 'approve', labelKey: 'tui.plan.approve', value: 'approve' },
  { id: 'feedback', labelKey: 'tui.plan.feedback', value: 'feedback' },
  { id: 'cancel', labelKey: 'tui.plan.cancel', value: 'cancel' },
];

/** Return all interactive fields for ack-error label lookup. */
type InteractiveField = import('../../platform/types.js').ModalSelectField
  | import('../../platform/types.js').ModalMultiSelectField
  | import('../../platform/types.js').ModalTextInputField;

// ── Component ──

export function PlanFeedbackModal({
  modal,
  triggerId,
  sendFrame,
  ackErrors,
  onClose,
}: PlanFeedbackModalProps): React.JSX.Element {
  // ── State ──

  /** Currently focused slot: 0=approve, 1=feedback, 2=cancel, 3=submit */
  const [focusSlot, setFocusSlot] = useState(0);
  /** Which option is radio-selected (follows focus for slots 0-2, frozen for slot 3) */
  const [activeOption, setActiveOption] = useState<'approve' | 'feedback' | 'cancel'>('approve');
  /** Interaction mode */
  const [mode, setMode] = useState<'decision' | 'feedback-text' | 'submitted'>('decision');
  /** Feedback text input buffer */
  const [feedbackText, setFeedbackText] = useState('');
  /** Prevent double-submit */
  const submittedRef = useRef(false);

  // Reset submitted when ack errors arrive — user can fix and resubmit
  useEffect(() => {
    if (Object.keys(ackErrors).length > 0) {
      submittedRef.current = false;
      setMode('decision');
    }
  }, [ackErrors]);

  // ── Extract plan text from section field ──

  const planText = modal.fields.find(f => f.type === 'section')?.text ?? '';

  const SLOT_COUNT = 4; // 3 options + submit

  // ── Submit ──

  const handleSubmit = useCallback((option: 'approve' | 'feedback' | 'cancel', fbText: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setMode('submitted');

    const values: Record<string, Record<string, Record<string, string>>> = {};
    values.decision = { decision: { value: option } };
    if (option === 'feedback' && fbText) {
      values.feedback = { text: { value: fbText } };
    }

    sendFrame({
      type: 'modal.submit',
      id: `modal-submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      callbackId: modal.callbackId,
      privateMetadata: modal.privateMetadata || '',
      values,
      userId: 'tui',
    } as TuiFrame);
  }, [modal, sendFrame]);

  // ── Keyboard handling ──

  useInput((input, key) => {
    // Escape
    if (key.escape) {
      if (mode === 'feedback-text') {
        // Exit feedback mode back to decision mode
        setMode('decision');
        return;
      }
      if (!submittedRef.current) {
        onClose();
      }
      return;
    }

    if (submittedRef.current) return;

    // ── Feedback text input mode ──

    if (mode === 'feedback-text') {
      if (key.return) {
        handleSubmit('feedback', feedbackText);
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText(prev => prev.slice(0, -1));
        return;
      }
      if (input.length === 1 && !key.ctrl && !key.meta && !key.shift) {
        setFeedbackText(prev => prev + input);
        return;
      }
      return;
    }

    // ── Decision mode ──

    if (key.return) {
      if (focusSlot === 0) {
        handleSubmit('approve', '');
      } else if (focusSlot === 1) {
        // Enter feedback text mode
        setMode('feedback-text');
        setFeedbackText('');
      } else if (focusSlot === 2) {
        onClose();
      } else if (focusSlot === 3) {
        // Submit with the currently active option; cancel means close
        if (activeOption === 'cancel') {
          onClose();
        } else {
          handleSubmit(activeOption, activeOption === 'feedback' ? feedbackText : '');
        }
      }
      return;
    }

    // Arrow navigation — move focus (▶) only.
    // Selection (●) is changed only by numbered hot-keys, matching AskUserModal pattern.
    if (key.upArrow || key.downArrow) {
      if (key.downArrow && focusSlot < SLOT_COUNT - 1) {
        setFocusSlot(focusSlot + 1);
      } else if (key.upArrow && focusSlot > 0) {
        setFocusSlot(focusSlot - 1);
      }
      return;
    }

    // Numbered hot-keys
    if (input === '1') {
      setFocusSlot(0);
      setActiveOption('approve');
      return;
    }
    if (input === '2') {
      setFocusSlot(1);
      setActiveOption('feedback');
      return;
    }
    if (input === '3') {
      setFocusSlot(2);
      setActiveOption('cancel');
      return;
    }
  });

  // ── Render ──

  const submitLabel = modal.submitLabel || t('tui.modal.submit');

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="single">
      {/* Title */}
      <Text bold>{modal.title}</Text>

      {/* Plan text */}
      {planText ? (
        <Box marginTop={1} height={5} flexShrink={0}>
          <Text dimColor>{planText}</Text>
        </Box>
      ) : null}

      {/* Radio options */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, idx) => {
          const isFocused = focusSlot === idx;
          const isSelected = activeOption === opt.id;
          return (
            <Box key={opt.id}>
              <Text bold={isFocused}>
                {isFocused ? '▶' : ' '} {isSelected ? '●' : '○'} {idx + 1}. {t(opt.labelKey)}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Feedback text input (visible only in feedback-text mode) */}
      {mode === 'feedback-text' ? (
        <Box flexDirection="column" marginTop={1}>
          <Box
            borderStyle="single"
            paddingX={1}
            marginLeft={2}
          >
            {feedbackText ? (
              <Text>{feedbackText}</Text>
            ) : (
              <Text dimColor>{t('tui.plan.typeFeedback')}</Text>
            )}
          </Box>
        </Box>
      ) : null}

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
        <Text bold={focusSlot === 3} dimColor={focusSlot !== 3}>
          {focusSlot === 3 ? '▶' : ' '} [{submitLabel}]
        </Text>
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          {mode === 'feedback-text'
            ? t('tui.plan.hintFeedback')
            : t('tui.plan.hint')}
        </Text>
      </Box>
    </Box>
  );
}
