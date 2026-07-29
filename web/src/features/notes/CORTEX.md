Please update me when files in this folder change

Desktop project notes: shared provider plus header, Overview and non-modal pane views.
Pure view models group persisted notes and local copy serves English and Chinese surfaces.

| filename | role | function |
|---|---|---|
| NotesProvider.tsx | provider | Owns note queries, mutations and drawer state |
| NotesButton.tsx | view | Renders the persistent header entry |
| NotesOverviewCard.tsx | view | Adds and previews notes on Overview |
| NotesPane.tsx | view | Renders full note CRUD in the right pane |
| NotesViews.test.tsx | test | Covers persistent entries and action surfaces |
| notes-vm.ts | vm | Groups notes and formats timestamps |
| notes-vm.test.ts | test | Covers counts, groups and shortcuts |
| notes-copy.ts | copy | Defines English and Chinese note labels |
