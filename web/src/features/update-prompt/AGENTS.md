Please update me when files in this folder change.

The arbitration layer over the three update channels (`server-update/`, `app-update/`,
`hot-update/`): decides which single prompt shows, owns the manual check and mounts the
prompts. The channels import neither this directory nor each other; the frame they render into
is `design/DesktopUpdateFrame`, the typing gate is `lib/useUpdateGating`, and a manual check's
report travels through `lib/manual-update-check-result`.

| filename | role | function |
|---|---|---|
| UpdateMount.tsx | mount | Headless desktop mount: renders whichever channel dialog `useUpdatePrompt` picks |
| useUpdatePrompt.ts | hook | Arbitrate the channels into one prompt |
| useUpdatePrompt.test.tsx | test | Test use update prompt |
| useSilentUpdateNotice.ts | hook | Manage silent update notice |
| useShellRecheckCascade.ts | hook | One manual cross-channel re-check the moment the server finishes restarting |
| useShellRecheckCascade.test.tsx | test | Test the post-restart re-check cascade |
| manual-update-check.ts | utility | Resolve manual update check |
| manual-update-check.test.ts | test | Test manual update check |
| update-check-feedback.ts | utility | Resolve update check feedback |
| useManualUpdateCheck.ts | hook | Manage manual update check |
| useManualUpdateCheck.test.tsx | test | Test use manual update check |
