Please update me when files in this folder change

Server self-management: update checks, CLI install, and install-wide health diagnostics.
Also holds operator display preferences and the admin system broadcast seam.

| filename | role | function |
|---|---|---|
| doctor.ts | core | checks runtime exports, auth state and system health |
| github-release.ts | client | fetches release notes for a version |
| install-cli.ts | cli | installs the latest Cortex release |
| preferences.ts | config | reads and writes operator display language |
| server-update-check.ts | core | checks settings-gated server package updates |
| system-notice.ts | core | Publishes Web notices and rich admin broadcasts |
| update-prompt.ts | types | update prompt interface and choice type |
| update-state.ts | util | persists skipped update versions |
