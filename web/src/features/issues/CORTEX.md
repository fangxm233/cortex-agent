Please update me when files in this folder change

Non-blocking issue queue read from each project's issue file.
Entries can be deleted or handed to a new direct session seeded with the issue text.

| filename | role | function |
|---|---|---|
| IssuesProvider.tsx | provider | Mounts the issues modal with open by id |
| IssueCenterModal.tsx | view | Renders the queue, detail, delete and handle |
| issues-vm.ts | vm | Parses issue bodies into display slots |
| issues-vm.test.ts | test | Unit tests for the issues view model |
