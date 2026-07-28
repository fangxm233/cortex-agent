# tui-session/ — B3 TUI Session Service

Transport-agnostic domain service owning TUI session lifecycle (handshake, resume, switch, transcript assembly).
No transport coupling (no ws imports). Consumed by M1 TUI gateway in a later task.

| filename | role | function |
|---|---|---|
| `types.ts` | types | HandshakeResolution, SwitchResolution, TuiSessionDeps, TuiSessionService interface |
| `tui-session-service.ts` | service | createTuiSessionService(deps) — resolveHandshake, switchSession, internal createFresh, assembleTranscript (reads the sessionId-keyed `conversationHistory` → message-based TranscriptData; no longer the per-channel ledger) |
| `index.ts` | barrel | re-exports createTuiSessionService and public types |
