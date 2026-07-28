Please update me when files in this folder change

Backend-neutral schema layer: the event, hook, tool-name, and prompt shapes every adapter converts to.
Shared by the Claude and PI adapters and by Cortex orchestration.

| filename | role | function |
|---|---|---|
| event-types.ts | types | normalized event union shared by adapters |
| event-stream.ts | core | queues events for a single producer |
| hooks.ts | types | backend-neutral hook specification |
| tool-names.ts | core | maps canonical and native tool names |
| prompt-builder.ts | core | builds prompt text from message attachments |
