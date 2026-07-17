# Persist ask-user / plan-approval interactions in conversation history

## Approach

Two parts: (A) persist answered interactions in conversation-history JSONL so
they're visible in historical sessions, and (B) query pending interactions from
server in-memory state so cards appear on any app/browser open.

### Part A: Persist answered interactions

Extend conversation-history with a new event type `'interaction'`:

```jsonl
{"type":"interaction","subtype":"ask-user","text":"Q: ... → A: ...","ts":"...","meta":{...}}
{"type":"interaction","subtype":"plan-approved","text":"Plan approved","ts":"...","meta":{...}}
```

- `HistoryEventType` gains `'interaction'`
- New `appendInteraction` method on ConversationHistoryRepo
- When the `answerQuestion` / `respondPlan` dep callbacks fire in app.ts,
  also call `conversationHistory.appendInteraction` + `publishSessionMessage`
- The transcript query maps these to `TranscriptMessage` with `type:'interaction'`
- Frontend renders them as a distinct row (AnsweredRow-style)

### Part B: Query pending interactions on mount

- `getGroupsByChannel(channel)` on ask-user-question module
- `getByChannel(channel)` on PlanApprovals
- New tRPC query `sessions.pendingInteraction` reads from these
- Frontend queries on mount to hydrate cards
- SSE still handles live arrivals

## Files to change

### Backend
1. `store/conversation-history-repo.ts` — extend HistoryEventType, add appendInteraction
2. `domain/ui-service/types.ts` — extend TranscriptMessage.type, add query types, add deps
3. `domain/ui-service/query/sessions.ts` — add handleSessionsPendingInteraction
4. `domain/ui-service/input-schemas.ts` — add schema
5. `domain/ui-service/app-router.ts` — wire query
6. `domain/ui-service/ui-service.ts` — wire handler
7. `orchestration/interactions/ask-user-question.ts` — add getGroupsByChannel
8. `orchestration/interactions/plan-approvals.ts` — add getByChannel
9. `entry/app.ts` — wire deps + persist on answer/approve
10. `events/event-types.ts` — extend session.message to allow interaction role

### ui-contract
11. `dto.ts` + `schemas.ts` — re-export new types

### Frontend
12. `useSessionInteractions.ts` — query on mount, remove module-level Map
13. `transcript-vm.ts` — handle interaction ChatRow kind
14. `MChatView.tsx` or `MessageStream.tsx` — render interaction rows
