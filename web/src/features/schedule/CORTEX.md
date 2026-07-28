Please update me when files in this folder change

The new-schedule overlay: a global modal that creates a schedule through the real add mutation.
Type selection drives which timing fields show, and a success refreshes the schedules list.

| filename | role | function |
|---|---|---|
| ScheduleModalProvider.tsx | provider | Mounts the modal and owns form submission |
| ScheduleModal.tsx | view | Renders the form fields and footer actions |
| schedule-modal-vm.ts | vm | Maps form values to add args and next run |
| schedule-modal-vm.test.ts | test | Unit tests for the schedule modal view model |
