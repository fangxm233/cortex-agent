Please update me when files in this folder change

Feishu side of the MCP layer — authenticated Feishu API access and the feishu_* tool registrations.

| filename | role | function |
|---|---|---|
| client.ts | core | Builds an authenticated Feishu API client |
| file.ts | tool | Registers the Feishu file sending tool |
| index.ts | entry | Registers all Feishu tools on a server |
| types.ts | types | Tool dependency shapes and result helpers |
| user-auth.ts | core | Obtains and refreshes Feishu user tokens |
