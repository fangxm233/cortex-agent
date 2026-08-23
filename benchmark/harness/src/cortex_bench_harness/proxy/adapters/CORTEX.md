Update this file whenever this directory changes

Provider adapters carry one vendor protocol each: routes, body model, auth form, and measured usage. Limit enforcement stays outside an adapter.

| filename | role | function |
|---|---|---|
| __init__.py | registry | Selects one adapter by exact capability key and binds the frozen cap |
| base.py | types | Defines the adapter protocol and decisions |
| anthropic.py | adapter | Carries Anthropic API-key and subscription OAuth rows |
| deepseek_chat_completions.py | adapter | Accepts either DeepSeek cap alias under one frozen value and audits terminal SSE |
| openai_codex_responses.py | adapter | Carries current Codex responses OAuth and terminal events |
