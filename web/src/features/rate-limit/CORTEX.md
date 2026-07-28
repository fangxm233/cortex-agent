Please update me when files in this folder change

Active-only provider throttle status shared by the desktop rail and the mobile projects header.
The server query is authoritative; live events only hint a refetch and a local clock keeps countdowns fresh.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Exports the view model, hook and components |
| RateLimitStatus.tsx | view | Desktop popover, mobile sheet and window details |
| rate-limit-vm.ts | vm | Filters expired windows and formats recovery copy |
| rate-limit-vm.test.ts | test | Unit tests for the rate limit view model |
| useRateLimitStatus.ts | hook | Owns the query, live sync and local ticking |
