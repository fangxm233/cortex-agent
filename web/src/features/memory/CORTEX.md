Please update me when files in this folder change

Project memory browser rendered as the center column of the workbench frame.
Shares canonical hierarchical tree facts with mobile while retaining rendered Markdown, diff and blame.

| filename | role | function |
|---|---|---|
| MemoryPage.tsx | entry | Route frame assembling rails around the view |
| MemoryView.tsx | view | Center pane with selectable top-level/nested files, diff toggle and body |
| MarkdownView.tsx | view | Renders parsed markdown nodes, with opt-in async image resolution |
| markdown.ts | core | Parses frontmatter, Markdown, images and code-safe opt-in math |
| markdown.test.ts | test | Tests Markdown and math parser behavior |
| memory-tree.ts | core | Canonicalizes top-level/nested paths, directories, count and first file |
| memory-tree.test.ts | test | Tests shared hierarchical memory facts and nested fallback |
| memory-vm.ts | vm | Projects shared facts into desktop rows, diffs and blame groups |
| memory-vm.test.ts | test | Tests hierarchical selection and blame-row state |
