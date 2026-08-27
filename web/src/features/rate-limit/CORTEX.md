Please update me when files in this folder change

Active-only provider throttle status shared by the desktop rail and mobile.
It keeps the compact banner and pill window-free while preserving full provider-window details.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the view model, hook and components |
| RateLimitStatus.tsx | view | Shows the rail banner, mobile pill, window details and clear actions |
| RateLimitStatus.test.tsx | test | Pins Radix trigger prop forwarding on the rail banner |
| rate-limit-vm.ts | vm | Builds compact labels, model labels, reset times and waiting counts |
| rate-limit-vm.test.ts | test | Tests throttle expiry, recovery arithmetic, ordering and model scope |
| useRateLimitStatus.ts | hook | Owns the query, live sync and local ticking |
