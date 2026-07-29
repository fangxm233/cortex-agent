Please update me when files in this folder change

Project dashboard rendered as the center column of the workbench frame.
Shows cost summary, budget and recent spend, schedules and executions.

| filename | role | function |
|---|---|---|
| OverviewPage.tsx | entry | Route frame assembling rails around the view |
| OverviewView.tsx | view | Center pane with cost, notes and project cards |
| overview-vm.ts | vm | Derives money, schedule and execution display |
| overview-vm.test.ts | test | Unit tests for the overview view model |
