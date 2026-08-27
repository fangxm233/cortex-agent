Please update me when files in this folder change

Surfaces turn-scoped direct-chat assistant replies and server system notices through one shared feed.
The feed owns direct-session gating, buffering, queue semantics and external-delivery fallback; shells only adapt open-session predicates, navigation and presentation.

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
| useNotificationFeed.ts | hook | Unifies direct-session mapping, turn gates, notices, queue and external fallback |
| useNotificationFeed.test.tsx | test | Tests shared feed gating, delivery fallback, dedupe, dismissal and unmount safety |
| useSystemNotices.ts | hook | Feeds system notice events to a callback |
| os-notify.ts | util | Delivers OS notifications and tap events |
| os-notify.test.ts | test | Unit tests for the OS notification bridge |
