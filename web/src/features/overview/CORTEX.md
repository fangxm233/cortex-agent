Please update me when files in this folder change

Project dashboard rendered as the center column of the workbench frame.
Shows cost summary, budget and recent spend, schedule management and executions.
Project scope and fallback derivation come from the neutral projects feature.

| filename | role | function |
|---|---|---|
| OverviewPage.tsx | entry | Route frame assembling rails around the view |
| OverviewView.tsx | view | Center pane with cost, notes and project cards |
| OverviewView.test.tsx | test | Tests schedule edit, delete and resume actions |
| overview-vm.ts | vm | Derives canonical USD money, schedule and execution display |
| overview-vm.test.ts | test | Tests session project fallback, duration and budget arithmetic |
