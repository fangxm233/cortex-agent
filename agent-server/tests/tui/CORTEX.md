Please update me when files in this folder change

Regression tests for the terminal UI: input box, modals, dashboard tabs,
transcript state, render helpers and the websocket client.

| filename | role | function |
|---|---|---|
| askUserModal.test.tsx | test | Covers ask-user modal submit and cancel |
| confirmModal.test.tsx | test | Covers confirm modal keys and reason input |
| dashboard-render-loop.test.tsx | test | Covers dashboard effect re-fire regression |
| dashboardExecutionsTab.test.tsx | test | Covers executions tab cancel row action |
| dashboardSchedulesTab.test.tsx | test | Covers schedules tab row actions and errors |
| dashboardTasksTab.test.tsx | test | Covers tasks tab row actions and errors |
| dashboardThreadsTab.test.tsx | test | Covers threads tab cancel and terminal case |
| inline-markdown.test.tsx | test | Covers inline markdown marker stripping |
| inputBox-ctrl-leak.test.tsx | test | Covers ctrl key character leak regression |
| inputBox-edit.test.tsx | test | Covers paste, multi-line and slash arguments |
| inputBox-slash.test.tsx | test | Covers the slash command palette |
| inputBox.test.tsx | test | Covers submit gating, history and shortcuts |
| keybindings.test.tsx | test | Covers global keybinding handler dispatch |
| logic.test.ts | test | Covers focus, scroll and stream pure helpers |
| markdown.test.ts | test | Covers the minimal markdown parser |
| messageRow.test.tsx | test | Covers message row text and rich blocks |
| notificationBadge.test.tsx | test | Covers notification selection callback |
| planFeedbackModal.test.tsx | test | Covers plan approve, feedback and cancel |
| projectSwitcher.test.tsx | test | Covers project switcher select and escape |
| raf-batch.test.ts | test | Covers numeric coalescer and throttle |
| reconnect.test.ts | test | Covers websocket reconnect and resume hello |
| render-output.test.ts | test | Covers synchronized output writer and stats |
| rich-blocks.test.tsx | test | Covers rich block rendering rules |
| slash-commands.test.ts | test | Covers slash registry parse and filter |
| stream-batching.test.ts | test | Covers stream frame batching into state |
| transcript-orphan-stream.test.ts | test | Covers orphan stream frame recovery |
| transcript.test.ts | test | Covers transcript post, update and delete |
| turn-status.test.ts | test | Covers turn status line parse and format |
| useDashboardData.test.ts | test | Covers dashboard data subscribe lifecycle |
| useMutate.test.ts | test | Covers mutate request response correlation |
| useNotifications.test.ts | test | Covers notification ring buffer behaviour |
| ws-protocol-contract.test.ts | test | Covers client state across protocol frames |
