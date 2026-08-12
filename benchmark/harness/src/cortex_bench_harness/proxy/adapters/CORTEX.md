Update this file whenever this directory changes

Provider adapters carry one vendor protocol each: routes, body model, auth form, usage, and billable quantities. Budget enforcement stays outside an adapter.

| filename | role | function |
|---|---|---|
| __init__.py | registry | Selects one adapter by exact capability key and binds the frozen cap |
| base.py | types | Defines the adapter protocol and decisions |
| anthropic.py | adapter | Carries the Anthropic messages API-key row |
| deepseek_chat_completions.py | adapter | Carries DeepSeek chat completions policy under a frozen completion cap |
| openai_codex_responses.py | adapter | Carries the Codex responses OAuth row and its token host |
