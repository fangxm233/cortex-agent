Please update me when files in this folder change

Project dashboard rendered as the center column of the workbench frame.
Shows cost summary, budget and recent spend, schedule management and executions.

| filename | role | function |
|---|---|---|
| OverviewPage.tsx | entry | Route frame assembling rails around the view |
| OverviewView.tsx | view | Center pane with cost, notes and project cards |
| OverviewView.test.tsx | test | Tests schedule edit, delete and resume actions |
| overview-vm.ts | vm | Derives money, schedule and execution display |
| overview-vm.test.ts | test | Tests project selection, execution duration and budget arithmetic |
