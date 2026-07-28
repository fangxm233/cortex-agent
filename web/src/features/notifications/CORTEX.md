Please update me when files in this folder change

Surfaces direct-chat assistant replies and server system notices as in-app toasts on the desktop shell.
Direct-chat toasts are turn-scoped so one toast fires per turn; the mobile shell reuses the same model.

| filename | role | function |
|---|---|---|
| NotificationProvider.tsx | provider | Wires live streams into the queued toast stack |
| NotificationToaster.tsx | view | Stacked toast bubbles with an overflow pill |
| notification-toaster.test.ts | test | Unit tests for toaster relative age labels |
| notification-store.ts | core | Queues, dedupes, caps and splits visible toasts |
| notification-store.test.ts | test | Unit tests for the notification queue |
| notification-vm.ts | vm | Builds toast items and transient-level policy |
| notification-vm.test.ts | test | Unit tests for the notification view model |
| turn-buffer.ts | core | Buffers each session's latest assistant message |
| turn-buffer.test.ts | test | Unit tests for the turn buffer |
| useDmNotifications.ts | hook | Feeds assistant messages and turn ends onward |
| useSystemNotices.ts | hook | Feeds system notice events to a callback |
| os-notify.ts | util | Delivers OS notifications and tap events |
| os-notify.test.ts | test | Unit tests for the OS notification bridge |
