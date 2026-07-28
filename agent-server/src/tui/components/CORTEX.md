Please update me when files in this folder change

Screen components of the terminal client: transcript, input box, status line, dashboard tabs, and modal dialogs.
They form the presentation layer of the TUI and receive their state from the app shell above them.

| filename | role | function |
|---|---|---|
| AskUserModal.tsx | modal | asks the user a question and returns answers |
| ConfirmModal.tsx | modal | confirms a destructive action |
| dashboard-constants.ts | const | defines the shared dashboard row cap |
| Dashboard.tsx | view | hosts the dashboard tabs and tab switching |
| DashboardCostTab.tsx | tab | shows cost totals by period and mode |
| DashboardExecutionsTab.tsx | tab | lists executions and cancels one |
| DashboardSchedulesTab.tsx | tab | lists schedules and pauses or removes them |
| DashboardTasksTab.tsx | tab | lists tasks and changes their state |
| DashboardThreadsTab.tsx | tab | lists threads and cancels one |
| InputBox.tsx | input | edits and submits the user message |
| MessageRow.tsx | legacy | renders one message with text and rich blocks |
| Notifications.tsx | view | shows the notification badge and list |
| PlanFeedbackModal.tsx | modal | approves, rejects, or comments on a plan |
| ProjectSwitcher.tsx | modal | picks the active project |
| SessionPicker.tsx | modal | picks a session to resume |
| SidePanel.tsx | view | holds the toggleable dashboard panel |
| SlashMenu.tsx | view | lists the matching slash commands |
| StatusLine.tsx | view | shows the bottom status and shortcut hints |
| Transcript.tsx | view | shows the scrollable conversation history |
