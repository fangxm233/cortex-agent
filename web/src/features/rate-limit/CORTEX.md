Please update me when files in this folder change

Active-only provider throttle status shared by desktop and mobile.
It keeps compact pills window-free while preserving full provider-window details.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the view model, hook and components |
| RateLimitStatus.tsx | view | Shows compact pills, provider details and clear actions |
| RateLimitStatus.test.tsx | test | Pins Radix trigger prop forwarding on the desktop pill |
| rate-limit-vm.ts | vm | Builds compact labels, reset times and waiting counts |
| rate-limit-vm.test.ts | test | Tests compact labels, countdowns and waiting counts |
| useRateLimitStatus.ts | hook | Owns the query, live sync and local ticking |
