Please update me when files in this folder change.

Native Android notification library sources and verification.

| filename | role | function |
|---|---|---|
| ActionLedger.kt | core | Retain tap actions and current alert identities |
| AlertChanges.kt | core | Calculate owner-scoped alert changes |
| Completions.kt | core | Decide and dedupe finished direct-session turns |
| CortexTransport.kt | adapter | Fetch HTTPS snapshots and subscribe with auth |
| NotificationDismissReceiver.kt | entry | Release explicitly dismissed notification routes |
| NotificationPresenter.kt | adapter | Post private alerts, replies and completion notices |
| NotificationService.kt | entry | Own permission-gated foreground lifecycle |
| NotificationState.kt | core | Persist connection, ownership and guard async work |
| NotificationText.kt | utility | Localize short notification and completion labels |
| NotificationsPlugin.kt | entry | Expose bridge commands, screen state and tap events |
| Protocol.kt | core | Validate connections and parse server snapshots |
| Reconciler.kt | core | Reconcile snapshots, completions and SSE hints |
| SseDecoder.kt | utility | Frame bounded native SSE events |
