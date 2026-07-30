Please update me when files in this folder change

Inbound routing layer that carries external input into the agent orchestrator.
Covers chat messages, message edits, file attachments, agent hook requests and HTTP webhooks.

| filename | role | function |
|---|---|---|
| commands/ | subdir | handlers for chat bang commands |
| edit-handler.ts | core | reruns a turn when a user edits a message |
| file-handler.ts | util | downloads attachments and classifies types |
| hook-bridge.ts | core | pairs hook requests with replies and blocking TTL |
| hook-bridge-subscribers.ts | handlers | posts question and plan requests to users |
| message-router.ts | entry | routes chat messages to the orchestrator |
| webhook.ts | entry | serves routes with settings-backed depth limits |
