Please update me when files in this folder change

The schedule overlay: a global modal that creates or edits a schedule via add/update mutations.
Type selection drives which timing fields show, and a success refreshes the schedules list.

| filename | role | function |
|---|---|---|
| ScheduleModalProvider.tsx | provider | Mounts the modal, owns create and edit submit |
| ScheduleModal.tsx | view | Renders typed schedule fields and compact selections |
| ScheduleModal.test.tsx | test | Tests selection density, patches and edit locks |
| schedule-modal-vm.ts | vm | Maps forms to add/update args and next run |
| schedule-modal-vm.test.ts | test | Unit tests for the schedule modal view model |
