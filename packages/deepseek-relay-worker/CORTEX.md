Update me whenever files in this folder change

Authenticated Cloudflare Worker package for DeepSeek API egress.

| filename | role | function |
|---|---|---|
| `package.json` | config | Define test, typecheck, and deploy scripts |
| `tsconfig.json` | config | Typecheck Worker and tests |
| `wrangler.toml` | deploy | Bind Worker entrypoint and custom domain |
| `src/` | source | Implement authenticated DeepSeek relay |
| `tests/` | tests | Verify relay security and streaming behavior |
