import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { UncontrolledTextInput } from 'ink-text-input';
import { t } from '../../core/i18n.js';

export interface ConfirmModalProps {
  title: string;
  body: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  reasonInput?: {
    label: string;
    placeholder?: string;
  };
}

export function ConfirmModal({
  title,
  body,
  onConfirm,
  onCancel,
  reasonInput,
}: ConfirmModalProps): React.JSX.Element {
  const handleReasonSubmit = useCallback((text: string) => {
    onConfirm(text);
  }, [onConfirm]);

  useInput((input, key) => {
    if (reasonInput) {
      // When reason Input is active, only Esc cancels.
      // Enter is handled by UncontrolledTextInput's internal onSubmit.
      if (key.escape) {
        onCancel();
      }
      return;
    }

    if (input === 'y' || key.return) {
      onConfirm();
    } else if (input === 'n' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="single">
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <Text>{body}</Text>
      </Box>
      {reasonInput ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{reasonInput.label}</Text>
          <UncontrolledTextInput
            placeholder={reasonInput.placeholder ?? ''}
            onSubmit={handleReasonSubmit}
          />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          {reasonInput
            ? t('tui.confirm.hintReason')
            : t('tui.confirm.hint')}
        </Text>
      </Box>
    </Box>
  );
}
