Please update me when files in this folder change

The app's single live event subscription, carrying session, thread, task, system, config and throttle events.
Fans events out to scoped listeners and publishes link state plus a shared reconnect epoch.

| filename | role | function |
|---|---|---|
| LiveEventsProvider.tsx | provider | Owns the one stream and fans events out |
| live-events.ts | core | Defines event groups, filters and fan-out rules |
| live-events.test.ts | test | Unit tests for event grouping and fan-out |
