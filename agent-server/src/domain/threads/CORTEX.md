Please update me when files in this folder change

Thread domain layer — S7 split result of thread-manager.ts (1098 lines) (2026-04-26).
External callers should import from index.ts, not reference sub-files directly.

| filename | role | function |
|---|---|---|
| `utils.ts` | utility | isDefaultThread / isAdHocThread / getSessionKey / parseTarget / resolveStageName / resolveTargetResumeId (hook targetAgent backend `--resume` target, track/backend-decoupling + legacy aware) |
| `artifact-io.ts` | I/O | readArtifact / cleanupWorkspace / getModifiedFilesFromSession / getSessionFileChanges / renderModifiedFilesWithDiff / FileChange |
| `template-loader.ts` | config | loadConfig (DR-0017 D6 Phase 2.5: directory form `config/thread-templates/{agents,templates,shells}/` preferred, legacy single file fallback; expands shell-binding templates via shell-templates, fail-soft per entry) / migrateThreadTemplatesToDir (one-time single-file → dir split + `.migrated-bak`) / mergeThreadTemplates (per-file copy-if-missing defaults dir → user dir) / startConfigWatcher (watches each entity subdir) / stopConfigWatcher / getTemplate / getAgent / listTemplates / listTemplateNames / listAgents / resolveFileRef |
| `shell-templates.ts` | config | isShellBinding / expandShell — DR-0017 D6 Phase 2.5: GENERIC interpolation of a shell binding + a pure-JSON ShellDefinition (`shells/*.json`) into a full ThreadTemplate (`{param}` → agent name, `{param.entryStage}` → agent entryStage); no per-shell hardcoded expander; 7 validation semantics preserved |
| `prompt-builder.ts` | build | buildStepPrompt / buildConversationPrompt / resolveSystemVars / resolveAgentSlotConfig / resolveTemplateAgents / resolveTemplateProfiles (template→profile set, used by task-dispatch rate-limit gating) / formatEndpoint / pickStepTemplate / THREAD_PROTOCOL_PREAMBLE |
| `state-machine.ts` | state machine | createThread (DR-0017 W1: manager-template dispatch threads anchor artifactPath on the task node via core/task-node ensureTaskArtifact — durable, never truncated) / addAgentToThread / resolveNextStep / evaluateTransitions / **beginStepSession** (track/backend id decoupling, mirrors the direct path: mints + persists the slot's stable track `sessionId` BEFORE the agent spawns — the UI transcript key for the RUNNING step — resolves the `backendSessionId` resume target, migrates legacy records in place) / recordStepResult (also stores `backendSessionId` on the step + persist slot) / completeThread / failThread / cancelThread / abortThread / tryEnterWaiting (thread + task children, §8) / peekPendingControl / clearPendingControl / detectSplitFromControl (DR-0015 out-of-band control plane — replaces the old artifact string-marker detectors) / isArtifactUnchangedSinceStepStart + step-start artifact-hash baseline in createThread/recordStepResult (DR-0017 W2 checkpoint gate). Publishes the thread lifecycle EventBus events (previously declared but never emitted): `thread.created` / `thread.step.started` (beginStepSession) / `thread.step.finished` (recordStepResult) / `thread.transitioned` / `thread.completed` / `thread.failed` (cancel/abort map to failed) — via the job-registry ctx bus, no-op without a bus |
| `runner.ts` | runtime | runThread / continueThread / resumeThread / buildThreadSummary — thread execution engine, registers handle via runningExecutions. Threads are created by task dispatch (and resumed via the `/webhook/thread-op` `control` bridge). The agent-facing `thread_start` spawn tool was removed: delegation is via the task system (`cortex-task spawn`/`add`). At each step boundary the runner reads metadata.pendingControl (written out-of-band by the thread_abort/split/wait tools, DR-0015) and dispatches abort / split / wait — no artifact scanning. Step session identity comes from beginStepSession (AFTER buildStepPrompt — the prompt builder reads slot.sessionId truthiness as "resuming"): runAgent gets `sessionId`=backend resume target + `trackSessionId`=stable track id (→ CORTEX_SESSION_ID, so session-activity logs are keyed correctly from the FIRST step); streamed assistant/tool events go through the live StepTranscriptRecorder (append + session.message publish per event) instead of the old end-of-step flush; recordStepOutcome settles the recorder, records the step keyed by the track id (backend id stored alongside) and registers the session under the track id. |
| `tree.ts` | tree (DR-0014) | getRootThreadId / getTreeThreads / summarizeTree / checkSpawnGuards (width+nodes+budget) / registerChildSpawn / buildThreadTree — recursive thread-tree identity, resource guards, tree view |
| `contract.ts` | contract (DR-0014) | buildContractPrompt / buildMissionChain / checkContractBudget — structured delegation contracts, ancestor goal chain, per-thread budget breaker |
| `hook-runner.ts` | hook | executeLifecycleHook — lifecycle hook script executor + hook agent runner |
| `thread-transcript.ts` | transcript | createStepTranscriptRecorder — records a thread step's conversation INCREMENTALLY into conversation-history, keyed by the slot's stable track sessionId (minted at step start by beginStepSession), publishing each event live (`session.message`, shared ts with the persisted entry for the web de-dup) — so a RUNNING step renders from the on-disk snapshot (sessions.transcript) + delta stream and survives reloads / session switches / server restarts. Replaced the old buffer→flush pair (buffering existed only because the sessionId used to be known after the run). An interrupted step is partially recorded (honest history); its re-run opens a fresh prompt turn. |
| `index.ts` | entry | barrel re-export, the only import point for all external callers |

## Internal dependency order (acyclic)

```
utils.ts          → threadStore, thread-types
artifact-io.ts    → threadStore, REPO_ROOT, fs, diff
shell-templates.ts → thread-types (pure)
template-loader.ts → DATA_DIR, REPO_ROOT, template-resolver, shell-templates, thread-types
prompt-builder.ts  → template-loader, artifact-io, threadStore, thread-types, memory/user-context
contract.ts        → thread-types (pure)
tree.ts            → threadStore, thread-types
state-machine.ts   → threadStore, template-loader, prompt-builder, utils, artifact-io, contract
index.ts           → all of the above
```
