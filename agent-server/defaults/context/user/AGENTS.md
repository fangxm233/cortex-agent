# user/ Index

User-level memory directory. Stores user personal preferences and context across projects and sessions.

## File List

| File | Type | Purpose |
|------|------|---------|
| `USER.md` | Agent maintained | User profile: identity, communication preferences, output style, technical background, work habits. Hard limit 3KB |

## Rules

- `USER.md` is maintained by the agent (`/user-learn` skill); the user corrects it by saying so in chat
- Injected only into plain direct conversation turns (the thread-free chat path); multi-agent thread steps never carry the user profile
- Injected by default; set environment variable `CORTEX_DISABLE_USER_CONTEXT=1` to disable
- File hard limit 3KB, compress rather than grow when approaching the limit

## Lookup Rules

- **Find user preferences** -> `USER.md`
- **Modify user preferences** -> `/user-learn`
