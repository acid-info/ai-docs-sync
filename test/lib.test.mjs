import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERSION } from '../lib.mjs';

test('lib.mjs imports without side effects', () => {
  assert.equal(typeof VERSION, 'string');
});
