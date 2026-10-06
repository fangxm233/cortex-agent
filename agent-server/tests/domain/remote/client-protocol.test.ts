import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AUTH_HEADER } from '../../../src/core/auth.js';
import { AUTH_HEADER as CLIENT_AUTH_HEADER, buildClientHeaders } from '../../../../client/src/auth-headers.js';

// Server and client cannot import each other at runtime, so the header name is defined on both
// sides; this pins them together.
test('the client sends its token under the header the server checks', () => {
  assert.equal(CLIENT_AUTH_HEADER, AUTH_HEADER);
  assert.deepEqual(Object.keys(buildClientHeaders('token') ?? {}), [AUTH_HEADER]);
});
