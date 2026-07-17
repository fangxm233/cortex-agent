# Fix three issues with web ask-user / plan-approval cards

## Issues

1. **Desktop web (CenterChat) doesn't show cards** — `useSessionInteractions` is only used in
   MChatScreen (mobile). CenterChat/MessageStream has no interaction slot.

2. **Mobile loses card if not on chat screen when event fires** — `useSessionInteractions`
   subscribes via SSE, but if the user navigates away and back, the transient state is lost
   (the SSE event was already consumed). The backend has no "current pending interaction" query.

3. **Answered card disappears instead of showing answered state** — `onSuccess` immediately
   clears `pendingQuestion`/`pendingPlan` to null. Should transition to an `AnsweredRow` /
   approved state instead.

## Fixes

### Fix 1: Desktop CenterChat

Add the interaction hook + render slots to the desktop path:

- **CenterChat.tsx**: call `useSessionInteractions(sessionId)`, pass `pendingQuestion`,
  `pendingPlan`, `answeredQuestions`, and the callbacks as new props to `MessageStream`.
- **MessageStream.tsx**: accept optional `interactionSlot?: ReactNode` prop and render it
  after `inlineThreadCard`. CenterChat builds the slot content (reusing the mobile
  `AskQuestionCard` / `PlanApprovalCard` / `AnsweredRow` components from MChatView, or
  simpler: just pass a ReactNode slot that CenterChat assembles).

Simpler approach: MessageStream already takes an `inlineThreadCard` ReactNode slot. Add a
second `interactionsSlot?: ReactNode` and render it below the thread card. CenterChat builds
the slot from the hook data using the existing mobile card components.

### Fix 2: Persist pending interactions across navigation

Two-part fix:

**a) Backend: publish a `session.message` event alongside the interaction event** so the
pending interaction is visible in the transcript as a tool-call row (the agent IS calling
`cortex_ask_user` / `cortex_plan_exit` — it's a real tool use). This makes the interaction
visible even if the user wasn't on the chat screen.

**b) Frontend: query pending interactions on mount.** Add a lightweight tRPC query
`sessions.pendingInteraction({ sessionId })` that returns the current pending ask-user or plan
approval (if any) for the session. The hook calls this on mount and hydrates from it.

Actually, simpler approach: the EventBus events are fire-and-forget. Instead of a new query,
we can keep the state in the hook but make it resilient:

- The `session.askUser` / `session.planApproval` events already carry enough data.
- On the server side, when the web: subscriber fires, also publish a `session.message` with
  role=tool (or assistant) indicating a question/plan is pending — this appears in the
  transcript and survives navigation.
- The hook hydrates from the transcript on mount: if the last message is a pending interaction
  marker, show the card.

Actually the simplest approach: the hook currently resets state on sessionId change. Instead,
keep the interaction events' state keyed by requestId in a module-level Map (survives
component unmount within the same SPA session). On mount, check if there's an unresolved
interaction for this sessionId.

### Fix 3: Show answered state instead of disappearing

When the answer mutation succeeds, instead of setting `pendingQuestion` to null, move it to
an `answeredQuestions` array with the selected answer as summary. MChatView already renders
`answeredQuestions` via `AnsweredRow`. Same for plan: transition to a "Plan approved/rejected"
line.

## Implementation

### `useSessionInteractions.ts` changes

1. Add `answeredQuestions: AnsweredQuestionRow[]` to the return type.
2. On answer success: move pendingQuestion to answeredQuestions with summary text, don't null it.
3. On plan respond success: move pendingPlan to a "plan approved/rejected" answered row.
4. Use a module-level `Map<sessionId, { pending, answered }>` so state survives navigation.
5. On mount with a sessionId, hydrate from the map.

### `CenterChat.tsx` changes

1. Import and call `useSessionInteractions(sessionId)`.
2. Build an interactions ReactNode and pass it to MessageStream.

### `MessageStream.tsx` changes

1. Add `interactionsSlot?: ReactNode` prop.
2. Render it after the inline thread card.

### Backend: no change needed for fix 2

The module-level Map approach handles navigation resilience without a backend query. The SSE
subscription reconnects on mount and the Map preserves pending state.
