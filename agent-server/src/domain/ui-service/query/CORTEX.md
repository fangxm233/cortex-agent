Please update me when files in this folder change

Read side of the UI service — one handler module per domain area the UI displays.
Handlers return DTOs only and never change state.

| filename | role | function |
|---|---|---|
| sessions.ts | query | lists sessions and serves full/compact transcripts plus exact-id subagent detail |
| threads.ts | query | Normalizes thread lists and builds detail |
| tasks.ts | query | Maps readiness, dependencies and claim threads |
| task-verification.ts | query | gathers done-when evidence for one task |
| executions.ts | query | lists and fetches dispatch executions |
| schedules.ts | query | lists scheduled tasks |
| commissions.ts | query | lists commissions and folds decisions.jsonl into board cards |
| projects.ts | query | lists projects and their conduits |
| memory.ts | query | browses and reads project memory files |
| approvals.ts | query | lists pending approval entries |
| auth.ts | query | returns authentication status and Web-owned flow state |
| custom-providers.ts | query | lists user-defined PI providers without secrets |
| issues.ts | query | lists a project's issue entries |
| notes.ts | query | lists a project's private notes |
| cost.ts | query | reports the cost summary |
| config.ts | query | Returns redacted config and settings provenance |
| hooks.ts | query | Builds the hook registry read model |
| machines.ts | query | lists machines with live connection state |
| machine-detail.ts | query | probes one machine and joins its running runs |
| machine-probe.ts | 工具 | builds and parses the machine telemetry probe |
| skills.ts | query | lists available skill groups |
| plugin-source.ts | query | Reads one SKILL.md and the redacted MCP server drafts |
| plugins.ts | query | lists plugins and assignment targets |
| thread-templates.ts | query | lists thread template definitions with validity and origin |
| thread-template-detail.ts | query | returns one entity's raw body, hash, issues and references |
| system.ts | query | Reports process, labeled throttle, and provider usage state |
