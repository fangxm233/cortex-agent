Please update me when files in this folder change

Interaction layer of the agent server, holding the state of exchanges that pause an agent until a user answers.
Covers user questions, plan approvals, version-update prompts, and the delivery of replies back to the agent.

| filename | role | function |
|---|---|---|
| ask-user-question.ts | state | tracks pending user questions and answers |
| command-action-router.ts | router | routes button and modal events to commands |
| interaction-handlers.ts | handlers | registers question, plan and status actions |
| interaction-records.ts | store | records interactions and their outcomes |
| plan-approvals.ts | state | holds pending plan approvals per request |
| plan-handler.ts | util | posts a generated plan to the chat platform |
| plan-response.ts | core | delivers plan approve or reject to the agent |
| update-prompt.ts | factory | asks the user to confirm a version update |
| update-prompt-slack.ts | factory | asks Slack users to confirm a version update |
