Please update me when files in this folder change

Project domain — M1 core: Project as a first-class runtime entity.

| filename | role | function |
|---|---|---|
| `project-types.ts` | types | Project interface — id, name, kind (general/user), contextDir |
| `project-store.ts` | store | ProjectStore — list/get/exists/getDefault/resolveFromMessage from PROJECTS_DIR + createProject(name) (validated scaffold of a new user project; rejects traversal/reserved/dup, never overwrites) + auto-scaffold general/ + fs.watch cache invalidation |
| `index.ts` | entry | barrel re-export |
