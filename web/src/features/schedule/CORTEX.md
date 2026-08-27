Please update me when files in this folder change

The shared schedule editor: one headless controller owns profiles, form state, API locks and writes.
Desktop presents it as a global modal; mobile consumes the same controller inside its own sheet level.
Once edits never fabricate timing: the DTO has no original delay and update accepts no timing patch.

| filename | role | function |
|---|---|---|
| useScheduleEditorController.ts | controller | Unifies profile query, create/edit initialization, protected changes, writes and list invalidation |
| useScheduleEditorController.test.tsx | test | Tests real profiles, payloads, API field locks and invalidation |
| ScheduleModalProvider.tsx | provider | Exposes desktop open/edit actions and mounts the controller-backed modal |
| ScheduleModalProvider.test.tsx | test | Tests desktop context delegation and controller prop consumption |
| ScheduleModal.tsx | view | Renders desktop editable fields and honest once-edit capability copy |
| ScheduleModal.test.tsx | test | Tests typed patches, edit locks, once timing omission and Escape handling |
| schedule-modal-vm.ts | vm | Maps DTOs/forms to editable gates, add/update args, validation and next run |
| schedule-modal-vm.test.ts | test | Tests payloads, initialization, timing, validation and API-derived field gates |
