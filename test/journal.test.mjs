// A journal file holds one run, and its report never overwrites it or any other file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileJournal, readJournal, reportPathFor } from '../src/journal.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));

test('the report path never equals the journal, whatever the journal is called', () => {
  const dir = scratch();
  assert.equal(reportPathFor(path.join(dir, 'run.jsonl')), path.join(dir, 'run.md'));
  assert.equal(reportPathFor(path.join(dir, 'run.JSONL')), path.join(dir, 'run.md'));
  assert.equal(reportPathFor(path.join(dir, 'run.log')), path.join(dir, 'run.log.md'));
  assert.equal(reportPathFor(path.join(dir, 'run.md')), path.join(dir, 'run.md.md'));
  assert.equal(reportPathFor(path.join(dir, 'run')), path.join(dir, 'run.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an existing journal is refused instead of getting a second run appended', () => {
  const dir = scratch();
  const file = path.join(dir, 'run.jsonl');
  const journal = fileJournal(file);
  journal.write('order', { n: 1 });
  journal.close();
  assert.throws(() => fileJournal(file), /already exists; a journal holds one run/);
  assert.deepEqual(readJournal(file).map((e) => e.type), ['order'], 'the first run is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a journal name whose report would overwrite an existing file is refused', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'README.md'), 'keep me\n');
  assert.throws(() => reportPathFor(path.join(dir, 'README.jsonl')), /README\.md already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'keep me\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
