Please update me when files in this folder change

Active-only provider throttle status shared by desktop and mobile.
It shows provider windows and waiting session/thread counts from the authoritative server query.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the view model, hook and components |
| RateLimitStatus.tsx | view | Shows provider windows, waiting counts, and early-clear buttons |
| RateLimitStatus.test.tsx | test | Pins Radix trigger prop forwarding on the desktop pill |
| rate-limit-vm.ts | vm | Formats reset times and pending-work counts |
| rate-limit-vm.test.ts | test | Tests countdown and waiting-count view state |
| useRateLimitStatus.ts | hook | Owns the query, live sync and local ticking |
