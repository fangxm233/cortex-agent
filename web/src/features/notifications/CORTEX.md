Please update me when files in this folder change

Shares reply and system-notice delivery across desktop and mobile.
Owns Android background lifecycle and compatibility with older native shells.

| filename | role | function |
|---|---|---|
| NotificationProvider.tsx | provider | Adapts workbench-open suppression, navigation and desktop toaster props |
| NotificationProvider.test.tsx | test | Tests the thin desktop feed adapter and activation routing |
| NotificationToaster.tsx | view | Stacked toast bubbles with an overflow pill |
| notification-store.ts | core | Queues, dedupes, caps and splits visible toasts |
| notification-store.test.ts | test | Unit tests for the notification queue |
| notification-vm.ts | vm | Builds toast items and transient-level policy |
| notification-vm.test.ts | test | Unit tests for the notification view model |
| turn-buffer.ts | core | Buffers each session's latest assistant message |
| turn-buffer.test.ts | test | Unit tests for the turn buffer |
| useDmNotifications.ts | hook | Feeds assistant messages and turn ends onward |
| useNotificationFeed.ts | hook | Retains unknown turns through lookup failure, then delivers direct or discards confirmed non-direct turns |
| useNotificationFeed.test.tsx | test | Tests direct retry/flush, non-direct disposal, suppression, fallback, dedupe and unmount safety |
| useSystemNotices.ts | hook | Feeds system notice events to a callback |
| os-notify.ts | util | Posts native replies and normalizes legacy taps |
| os-notify.test.ts | test | Tests permission, native post and legacy fallback |
| mobile-notifications.ts | core | Owns native lifecycle, toggle and completion ownership |
| mobile-notifications.test.ts | test | Tests permission, resume, ownership and disabled sync |
