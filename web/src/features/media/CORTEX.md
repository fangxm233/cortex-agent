Please update me when files in this folder change

In-app previewers for attachments on desktop and mobile: image and video lightbox, PDF and text document modal.
Non-previewable types fall back to an authenticated download; also owns the docked pinned-preview pane.

| filename | role | function |
|---|---|---|
| MediaViewer.tsx | provider | Full-screen image and video lightbox context |
| DocViewer.tsx | provider | PDF and text preview modal with open context |
| PinnedPreviewProvider.tsx | provider | Holds pinned split-preview state and dock gating |
| PinnedPreviewPane.tsx | view | Renders the docked pane and its drag divider |
| pinned-preview.ts | core | Parses pin state and routes preview items |
| pinned-preview.test.ts | test | Unit tests for the pinned preview model |
| media-kind.ts | util | Maps an attachment type to image, video or none |
| media-kind.test.ts | test | Unit tests for the media kind classifier |
| doc-kind.ts | util | Classifies a name or type as pdf, text or none |
| doc-kind.test.ts | test | Unit tests for the document kind classifier |
| pdf-worker.ts | util | Lazily loads the PDF engine with its worker |
| pdf-pager.ts | util | Page clamping, current page and jump target math |
| pdf-pager.test.ts | test | Unit tests for the PDF pager math |
| VideoThumb.tsx | view | Video thumbnail from its captured poster |
| video-poster.ts | hook | Captures a video first frame as a poster image |
| video-poster.test.ts | test | Unit tests for poster sizing and seeking |
| useZoom.ts | hook | Wheel, pinch and pan zoom for the viewers |
| useZoom.test.ts | test | Unit tests for the zoom anchor math |
| useMediaSrc.ts | hook | Resolves a full-size source with a failure flag |
| useWorkspaceObjectUrl.ts | hook | Fetches a workspace path into an object URL |
| useDownloadFile.ts | hook | Downloads a workspace file and reports outcome |
