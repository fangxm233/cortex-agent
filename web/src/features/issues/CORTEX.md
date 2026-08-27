Please update me when files in this folder change

Non-blocking issue queue read from each project's issue file.
Desktop and mobile share canonical detail mapping and selection while retaining distinct views and handling controls.

| filename | role | function |
|---|---|---|
| IssuesProvider.tsx | provider | Mounts the issues modal with open by id |
| IssueCenterModal.tsx | view | Renders the queue, detail, delete and handle |
| issues-vm.ts | vm | Shares issue body parsing, detail mapping, selection and handling prompts |
| issues-vm.test.ts | test | Tests canonical desktop/mobile issue mapping and selection |
