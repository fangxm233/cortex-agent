Please update me when files in this folder change

Project notes: one project-scoped server resource shared by desktop and mobile, plus desktop drawer surfaces.
Every mutation refreshes its scoped list; pure view models and local copy remain presentation-specific.

| filename | role | function |
|---|---|---|
| useNotesResource.ts | resource | Owns the shared scoped list, CRUD, invalidation and async state |
| useNotesResource.test.tsx | test | Covers scope changes, disabled queries, CRUD, invalidation and status |
| NotesProvider.tsx | provider | Adapts the shared resource into the desktop drawer context |
| NotesButton.tsx | view | Renders the persistent header entry |
| NotesOverviewCard.tsx | view | Adds and previews notes on Overview |
| NotesPane.tsx | view | Reveals selected-note CRUD in the right pane |
| notes-vm.ts | vm | Groups notes and formats local timestamps |
| notes-vm.test.ts | test | Covers note grouping and keyboard shortcuts |
| notes-copy.ts | copy | Defines English and Chinese note labels |
