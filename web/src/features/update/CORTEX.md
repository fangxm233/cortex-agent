Please update me when files in this folder change

Shared update checks, prioritized prompt ownership and desktop dialog chrome.
Manual checks reconcile native results with the existing update sources before surfacing one prompt.

| filename | role | function |
|---|---|---|
| manual-update-check.ts | adapter | Checks native updates and publishes manual results |
| manual-update-check.test.ts | test | Tests native report contract and single-flight checks |
| useManualUpdateCheck.ts | hook | Exposes menu busy state and feedback lifecycle |
| useManualUpdateCheck.test.tsx | test | Tests prompt priority, re-show and cleanup |
| update-check-feedback.ts | adapter | Formats honest per-channel check feedback |
| update-check-feedback.test.ts | test | Tests bilingual statuses and native reasons |
| useUpdateGating.ts | hook | Defers updates while text-editing focus is active |
| useUpdateGating.test.tsx | test | Tests editable targets and deferred surfacing |
| useUpdatePrompt.ts | hook | Selects one update prompt after checks settle |
| useUpdatePrompt.test.tsx | test | Tests hook ownership and shell update priority |
| UpdateProvider.tsx | provider | Renders the selected desktop update dialog |
| UpdateProvider.test.tsx | test | Tests app, hot and empty rendering |
| DesktopUpdateFrame.tsx | view | Provides shared desktop update dialog chrome |
| DesktopUpdateFrame.test.tsx | test | Tests frame DOM, classes and close behavior |
| DesktopUpdateDialogs.test.tsx | test | Tests dialog copy, actions and button state |
