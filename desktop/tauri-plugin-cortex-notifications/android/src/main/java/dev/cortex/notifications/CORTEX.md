Please update me when files in this folder change.

Native Android notification library sources and verification.

| filename | role | function |
|---|---|---|
| ActionLedger.kt | core | Retain tap actions and current alert identities |
| AlertChanges.kt | core | Calculate owner-scoped alert changes |
| CortexTransport.kt | adapter | Fetch HTTPS snapshots and subscribe with auth |
| NotificationDismissReceiver.kt | entry | Release explicitly dismissed notification routes |
| NotificationPresenter.kt | adapter | Post private notifications and scoped targets |
| NotificationService.kt | entry | Own permission-gated foreground lifecycle |
| NotificationState.kt | core | Persist connection and guard asynchronous work |
| NotificationText.kt | utility | Localize short notification labels |
| NotificationsPlugin.kt | entry | Expose bridge commands and durable tap events |
| Protocol.kt | core | Validate connections and parse snapshots |
| Reconciler.kt | core | Reconcile snapshots and coalesced SSE hints |
| SseDecoder.kt | utility | Frame bounded native SSE events |
