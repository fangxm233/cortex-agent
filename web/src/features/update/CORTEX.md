Please update me when files in this folder change

Surface-neutral update overlay orchestration plus desktop-only shared presentation chrome.
Owns both native update hooks, gives app-shell updates priority, and emits at most one prompt.
Mobile keeps its distinct frame and provider under `mobile/v3/`.

| filename | role | function |
|---|---|---|
| useUpdateGating.ts | hook | Defers either update source while a text-editing surface has focus |
| useUpdateGating.test.tsx | test | Characterizes editable targets and deferred focusout surfacing |
| useUpdatePrompt.ts | hook | Owns both update hooks and selects app-update before hot-update |
| useUpdatePrompt.test.tsx | test | Verifies hook ownership, raw app priority, hot fallback and empty state |
| UpdateProvider.tsx | provider | Renders the one selected desktop update dialog |
| UpdateProvider.test.tsx | test | Verifies desktop app/hot selection and empty rendering |
| DesktopUpdateFrame.tsx | view | Preserves shared Radix chrome for desktop update dialogs only |
| DesktopUpdateFrame.test.tsx | test | Characterizes desktop frame DOM, classes and close behavior |
| DesktopUpdateDialogs.test.tsx | test | Preserves both desktop dialogs' copy, actions and button state |
