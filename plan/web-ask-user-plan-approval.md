# Web UI: Wire ask-user + plan-approval interactive cards

## Problem

`web:` conduit channels have no PlatformAdapter owner. In `hook-bridge-subscribers.ts`, when
`ask-user.requested` or `plan.submitted` fire for a `web:` channel, `adapter.postMessage()` routes
to the CompositeAdapter's `_noop` fallback — the interactive cards are silently dropped.

The mobile UI already has `AskQuestionCard` and `PlanApprovalCard` built + tested in `MChatView.tsx`
/ `m-chat-vm.ts`, but they receive no data because the backend has no session-scoped interaction
stream for the web client.

## Approach

Add `web:` branches in `hook-bridge-subscribers.ts` that publish new EventBus events. The web
frontend subscribes to these events via the existing SSE mechanism and renders the already-built
cards. User responses come back through new tRPC mutations that resolve the pending hook requests.

## Changes

### 1. `agent-server/src/events/event-types.ts` — add 2 event types

```typescript
| { type: 'session.askUser';       ts: string; sessionId: string; channel: string; requestId: string; questions: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean }[] }
| { type: 'session.planApproval';  ts: string; sessionId: string; channel: string; requestId: string; planContent: string; planFilePath: string | null }
```

These carry the minimal data the frontend needs to render the cards + submit answers back by
`requestId`.

### 2. `agent-server/src/orchestration/routing/hook-bridge-subscribers.ts` — web: branches

In the `ask-user.requested` subscriber, before the existing Feishu/Slack posting logic, add an
early branch:

```typescript
if (ev.channel.startsWith('web:')) {
  // Extract sessionId from `web:<sessionId>` conduit
  const webSessionId = ev.channel.slice(4);
  bus.publish({
    type: 'session.askUser',
    sessionId: webSessionId,
    channel: ev.channel,
    requestId: ev.requestId,
    questions: group.questions.map(q => ({
      question: q.question,
      header: q.header,
      options: q.options,
      multiSelect: q.multiSelect,
    })),
  });
  return; // skip adapter.postMessage (no-op for web: anyway)
}
```

Similarly in the `plan.submitted` subscriber:

```typescript
if (ev.channel.startsWith('web:')) {
  const webSessionId = ev.channel.slice(4);
  bus.publish({
    type: 'session.planApproval',
    sessionId: webSessionId,
    channel: ev.channel,
    requestId: ev.requestId,
    planContent: ev.planContent || '',
    planFilePath: ev.toolInput?.plan_file_path ?? null,
  });
  return; // skip adapter.postInteractive
}
```

The group creation + hook resolver registration + plan approval registration happen BEFORE
these branches (they already do), so the server-side state is ready for the user's response.

### 3. `agent-server/src/domain/ui-service/` — 2 new tRPC mutations

**`mutate/sessions.ts`** (or a new `mutate/interactions.ts`):

- `sessions.answerQuestion({ requestId, answers: Record<string, string> })`:
  Looks up the pending ask-user group by requestId (`getGroup` via groupId = `sessionId:requestId`),
  sets all answers, calls `tryResolveHook(group)` which resolves the pending HTTP request back to
  the MCP tool. Falls back to `resolveHookRequest(requestId, { answers })` directly.

- `sessions.respondPlan({ requestId, approved: boolean, feedback?: string })`:
  If approved: `planApprovals.resolve(requestId)` + `resolveHookRequest(requestId, { approved: true, reason: '' })`.
  If rejected: `planApprovals.reject(requestId)` + `resolveHookRequest(requestId, { approved: false, reason: feedback })`.

Both publish the existing `ask-user.answered` / `plan.approved` events so the frontend can clear
the cards.

### 4. Frontend: `web/src/mobile/v3/MChatScreen.tsx` — wire events + mutations

In `useSessionMessageLiveSync` (or a sibling hook), subscribe to `session.askUser` and
`session.planApproval` events (add to the events array). On receipt, set state that feeds the
already-built `pendingQuestion` / `pendingPlan` props of `MChatView`.

Wire `onAnswerQuestion` → call `sessions.answerQuestion` mutation.
Wire `onApprovePlan` / `onRejectPlan` → call `sessions.respondPlan` mutation.

On `ask-user.answered` / `plan.approved` events (or on mutation success), clear the pending state.

### 5. `@cortex-agent/ui-contract` — export the new mutation input schemas

Add zod schemas for the two new mutations in `input-schemas.ts` and wire them in `app-router.ts`.

## What stays unchanged

- The Slack / Feishu / TUI paths — they continue using `adapter.postMessage` / `adapter.openModal`
  as before.
- The MCP tool (`tui-ask.ts`, `tui-plan.ts`) — still POSTs to the webhook, blocks on the HTTP
  response.
- The `hook-bridge.ts` pending-request map — the web mutations resolve via the same
  `resolveHookRequest()` as Slack modal submits do.
- The PI backend path — unaffected (uses `sendExtensionUiResponse`).

## Testing

1. Smoke: `dryRun: true` webhook POST with a `web:` channel — verify the event is published on the bus.
2. Live: open a web UI session, have the agent call `cortex_ask_user` — verify the card renders and
   answering resolves the tool call.
3. Live: have the agent call `cortex_plan_exit` — verify the plan card renders and approve/reject
   resolves.
