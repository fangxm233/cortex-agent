Please update me when files in this folder change

Project memory browser rendered as the center column of the workbench frame.
Shows the memory file tree, rendered Markdown, line diff counts and per-line blame.

| filename | role | function |
|---|---|---|
| MemoryPage.tsx | entry | Route frame assembling rails around the view |
| MemoryView.tsx | view | Center pane with file tree, diff toggle and body |
| MarkdownView.tsx | view | Renders parsed markdown nodes as styled elements |
| markdown.ts | core | Parses frontmatter, inline spans and block nodes |
| markdown.test.ts | test | Unit tests for the markdown parser |
| memory-vm.ts | vm | Derives tree rows, diffs and blame groups |
| memory-vm.test.ts | test | Unit tests for the memory view model |
