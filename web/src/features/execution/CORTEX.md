Please update me when files in this folder change

Execution detail drawer: header, metadata and live streaming log output for one execution.
Opened by id from any dispatch row and able to cancel a running execution.

| filename | role | function |
|---|---|---|
| ExecutionLogDrawerProvider.tsx | provider | Mounts the drawer and exposes open by id |
| ExecutionLogDrawer.tsx | view | Wires execution detail, live log and cancel |
| LogDrawerView.tsx | view | Drawer chrome, log lines and stop button |
| execution-log-view.ts | vm | Derives status pill, meta line and stream gate |
| execution-log-view.test.ts | test | Unit tests for the log view model |
| log-buffer.ts | core | Accumulates log frames into a capped line ring |
| log-buffer.test.ts | test | Unit tests for the log buffer |
| useExecutionLogStream.ts | hook | Subscribes to the log stream and buffers frames |
