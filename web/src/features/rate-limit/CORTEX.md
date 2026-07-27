# features/rate-limit

This feature owns the active-only provider rate-limit status shared by the desktop rail and the mobile Projects header. The server query is authoritative; `rate-limit.changed` is only a refetch hint, and a local 30-second clock keeps countdowns current and removes expired records without fabricating a healthy placeholder.

`rate-limit-vm.ts` filters expired windows, computes each provider’s full recovery from its latest window, computes aggregate first recovery from the earliest provider recovery, and formats English or Chinese compact copy. `useRateLimitStatus.ts` owns the query, shared-SSE invalidation, reconnect recovery, and local clock. `RateLimitStatus.tsx` provides the desktop popover, mobile trigger and bottom sheet, and shared provider/window details. The adjacent tests lock down active-only rendering, independent reset times, aggregate semantics, ordering, and both languages.
