import { expect, test } from 'vitest';
import { parseInitAnswersJson } from '../src/entry/init.js';

test('local client enrollment is explicit and independent of local UI', () => {
  expect(parseInitAnswersJson('{}').localClient).toBeUndefined();
  expect(parseInitAnswersJson('{"localUi":{"enabled":true}}').localClient).toBeUndefined();
  expect(parseInitAnswersJson('{"localClient":{"enabled":false}}').localClient).toEqual({ enabled: false });
  expect(parseInitAnswersJson('{"localClient":{"enabled":true}}').localClient).toEqual({ enabled: true });
});
test.each([null, true, [], {}, { enabled: 'true' }, { enabled: 1 }])('reject malformed localClient %j', (localClient) => {
  expect(() => parseInitAnswersJson(JSON.stringify({ localClient }))).toThrow(/localClient/);
});
