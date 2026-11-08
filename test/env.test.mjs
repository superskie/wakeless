// .env handling: values written by live/agent.mjs read back in the file's own
// encoding, and a secret with a stray control character is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEnvFile, checkSecret, readEnvFile } from '../src/env.mjs';

const tempFile = (bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  if (bytes) fs.writeFileSync(file, bytes);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('appending to a UTF-16 LE .env keeps its encoding, so the new value reads back', () => {
  // What PowerShell 5's `>` writes: an FF FE byte order mark, then UTF-16 LE with CRLF lines.
  const { file, done } = tempFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ONECLICK_API_KEY=dummy-one\r\n', 'utf16le')]));
  appendEnvFile(file, { WAKELESS_TEST_ID: 'dummy-two' }, 'written by a test');

  const bytes = fs.readFileSync(file);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
  const env = readEnvFile(file, { overrides: false });
  assert.equal(env.ONECLICK_API_KEY, 'dummy-one');
  assert.equal(env.WAKELESS_TEST_ID, 'dummy-two');
  // A second append of the same key is refused instead of writing it twice.
  assert.throws(() => appendEnvFile(file, { WAKELESS_TEST_ID: 'dummy-three' }), /already set/);
  done();
});

test('appending to a UTF-8 .env, or creating one, stays UTF-8', () => {
  const { file, done } = tempFile('A=1');
  appendEnvFile(file, { B: '2' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\nB=2\n');
  const fresh = tempFile();
  appendEnvFile(fresh.file, { C: '3' }, 'new');
  assert.equal(fs.readFileSync(fresh.file, 'utf8'), '# new\nC=3\n');
  done();
  fresh.done();
});

test('a value that does not read back is reported instead of trusted', () => {
  // A UTF-16 LE file cut by one byte: whatever is appended lands out of step and reads as noise.
  const { file, done } = tempFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A=1\r\n', 'utf16le'), Buffer.from([0x41])]));
  assert.throws(() => appendEnvFile(file, { WAKELESS_TEST_ID: 'dummy' }), /does not read back/);
  done();
});

test('a secret must be printable ASCII, and the error names the variable but never the value', () => {
  assert.equal(checkSecret('GOOD', 'abc-123_XYZ.~'), 'abc-123_XYZ.~');
  for (const bad of ['FAKE\rmid', 'FAKE mid', 'FAKE\u0000', 'FAKE\u00e9']) {
    assert.throws(() => checkSecret('NEAR_INTENTS_AGENT_API_KEY', bad), (err) => {
      assert.match(err.message, /NEAR_INTENTS_AGENT_API_KEY holds a character that is not printable ASCII/);
      assert.doesNotMatch(err.message, /FAKE/);
      return true;
    });
  }
});
