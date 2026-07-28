Please update me when files in this folder change

TASKS.md write path split modules and single CLI entry. task-store.ts and CLI import from specific sub-modules, no barrel.

| filename | role | function |
|---|---|---|
| `task-lifecycle-edit.ts` | utility | TASKS.md I/O and line-level primitives; editTask supports set/add/remove/clear semantics |
| `task-id-utils.ts` | utility | 4-digit hex id generation and backfill validation |
| `task-state.ts` | state | claim/pause/approve/block state transitions |
| `task-completion.ts` | terminal state | complete/uncomplete + done-when completion validation (ISS-CS-007) |
| `task-mutations.ts` | mutation | add/batchEdit/decompose |
| `task-process.ts` | process | stopTask / stopTaskDryRun |
| `cortex-run.ts` | entry | CLI forwarding: `cortex-run.launch`/`cortex-run.cancel` unified via sendCommand to cortex-client (DR-0011 §4.8+§4.9), no local spawn |
| `task-cli.ts` | entry | Single task CLI (read + write subcommands), forwarded by `cortex-task` |

## cortex-run.ts — Single-path CLI forwarding (DR-0011)

**Architecture**: No local spawn. All execution forwarded via `sendCommand` to cortex-client. The client manages the full lifecycle: directory creation, watcher spawn, state tracking, stall detection, result collection, and callback push.

### Launch mode

```text
cortex-run [--device <name>] --name <name> [--stall 10m] [--gpu auto]
           [--task-project P --task-id ABCD] [--force]
           [--env-passthrough VAR1,VAR2,...]
           [--log-tail-bytes 5000]
           -- COMMAND [ARGS...]
```

Sends `cortex-run.launch` action via `sendCommand(device, { action: 'cortex-run.launch', params: { name, command, stall, gpu, force, cwd, env, logTailBytes, taskProject, taskId } })`.

Returns `{ pid, callbackId, resultDir }`. Task lifecycle reported back via `task-callback` WS message.

### Cancel mode

```text
cortex-run --cancel <name> [--device <name>] [--signal SIGTERM]
```

Sends `cortex-run.cancel` action via `sendCommand(device, { action: 'cortex-run.cancel', params: { name, signal } })`.

Returns `{ killed, pid }`.

### Task linkage

- `--task-project` + `--task-id`: calls `pendingTask()` before launch, defers completion/block to client callback
- `--task-id` validates as 4-char hex; rejects invalid IDs
- Callback handler on server side maps termination → `completeTask` (success, skipVerify) or `blockTask` (failure, with log tail)

### Entry point

Bundled as `dist/domain/tasks/system/cortex-run.js`, registered as `cortex-run` bin in package.json.
