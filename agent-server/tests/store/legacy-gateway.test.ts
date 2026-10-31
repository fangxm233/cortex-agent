import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readGatewayEndpoints } from '../../src/store/legacy-gateway.js';

let dir: string;
const file = () => path.join(dir, 'gateway.yaml');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-gateway-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('reading an earlier gateway.yaml', () => {
  it('returns each section\'s modes, a flat section as its one `default` mode, and skips settings', () => {
    fs.writeFileSync(file(), [
      'port: 9880', 'mode: plan', 'max_body_size_mb: 64',
      'anthropic:', '  plan:', '    base_url: https://api.anthropic.com', '  note: not a route',
      'deepseek:', '  base_url: https://relay.example.com/ds', '  keys:', '    - $RELAY_TOKEN',
      'stray: 3', '',
    ].join('\n'));
    expect(readGatewayEndpoints(file())).toEqual({
      anthropic: { plan: { base_url: 'https://api.anthropic.com' } },
      deepseek: { default: { base_url: 'https://relay.example.com/ds', keys: ['$RELAY_TOKEN'] } },
    });
  });

  it('is null for a missing or unparseable file', () => {
    expect(readGatewayEndpoints(file())).toBeNull();
    fs.writeFileSync(file(), 'anthropic: [unclosed\n');
    expect(readGatewayEndpoints(file())).toBeNull();
  });
});
