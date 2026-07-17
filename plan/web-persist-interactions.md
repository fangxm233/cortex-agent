# Persist ask-user / plan-approval cards across app open/close

## Problem

The interaction cards rely on a transient SSE event. If the app/browser isn't
open when the event fires, or the page is refreshed, the pending card is lost.
The server holds the pending state in memory (`pendingAskUserQuestionGroups`,
`planApprovals._map`) for the entire duration the MCP tool is blocked — this
state just isn't queryable by the frontend.

## Solution

Add a tRPC query `sessions.pendingInteraction({ sessionId })` that reads the
existing server-side Maps and returns the current pending ask-user or plan
approval (if any) for the session. The frontend calls this on mount to hydrate.
The SSE subscription handles live updates for cards that arrive while the app
is open.

No file persistence needed — the in-memory state lives exactly as long as the
MCP tool is blocked (same server process lifetime).

## Changes

### Backend

1. **`ask-user-question.ts`**: add `getGroupsByChannel(channel)` — iterates
   `pendingAskUserQuestionGroups` and returns groups matching the channel.

2. **`plan-approvals.ts`**: add `getByChannel(channel)` — iterates `_map`
   and returns `[requestId, PendingPlan]` pairs matching the channel.

3. **`types.ts`**: add `sessions.pendingInteraction` QueryScope + params/return types.
   Return shape:
   ```ts
   interface SessionPendingInteraction {
     askUser: { requestId: string; questions: { question: string; header: string; options: ...; multiSelect: boolean }[] } | null;
     plan: { requestId: string; planContent: string; planFilePath: string | null } | null;
   }
   ```

4. **`query/sessions.ts`**: add `handleSessionsPendingInteraction` handler —
   resolves `sessionId` → channel (`web:<sessionId>`), calls the two getBy
   functions, maps to the return type.

5. **`input-schemas.ts`** + **`app-router.ts`** + **`ui-service.ts`**: wire
   the new query.

6. **`UiServiceDeps`**: add injected callbacks `getPendingAskUser(channel)`
   and `getPendingPlan(channel)` (same layer-safety pattern as the rest).

7. **`entry/app.ts`**: wire the callbacks.

### Frontend

8. **`useSessionInteractions.ts`**: on mount, call `sessions.pendingInteraction`
   query to hydrate `pendingQuestion` / `pendingPlan`. The SSE subscription
   still handles live arrivals. Remove the module-level Map cache (the server
   is the source of truth now).

### ui-contract

9. Re-export the new types + schema.
