Please update me when files in this folder change.

Neutral attachment ownership shared unchanged by desktop and mobile.
Types, transport, queueing, aborts, retry order, progress, restoration, and preview lifetime have one source of truth.
No desktop or mobile surface may duplicate upload transport or queue state.

| filename | role | function |
|---|---|---|
| types.ts | model | Defines canonical metadata, upload items, accessors, completed metadata, and send gating |
| upload-attachment.ts | transport | Uploads one file with auth, Unicode headers, progress, abort, and stable failures |
| upload-attachment.test.ts | test | Tests upload wire headers, progress, 413, network, and pre-aborted signals |
| attachment-upload-store.ts | controller | Runs the bounded FIFO queue and owns abort, retry, restoration, and preview cleanup |
| useAttachmentUploads.ts | hook | Exposes the shared upload store to React desktop and mobile controllers |
| useAttachmentUploads.test.tsx | test | Tests concurrency, FIFO, retry, scope isolation, progress, restoration, cleanup, and send gates |
