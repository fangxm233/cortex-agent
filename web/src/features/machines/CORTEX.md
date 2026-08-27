Please update me when files in this folder change

Shared machine-domain ownership for desktop and mobile.
The resource owns transport lifecycle and polling; facts stay locale- and CSS-free while each surface keeps its own JSX and interaction model.

| filename | role | function |
|---|---|---|
| useMachinesResource.ts | resource | Polls the 10s roster, probes expanded online machines every 5s, exposes detail states, and queues add-machine approvals |
| useMachinesResource.test.tsx | test | Tests roster/probe polling, multi-expand gating, errors, and approval lifecycle |
| machine-detail-vm.ts | facts | Maps detail DTOs to locale- and CSS-free meters, GPU/process rows, runs, and timing facts |
| machine-detail-vm.test.ts | test | Tests machine meters, GPU ownership, process bounds, timing, and probe errors |
