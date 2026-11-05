// Append-only JSONL journal. Every decision is written with the inputs that
// produced it, so a report can be rebuilt from the file alone.
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonl } from './memory-journal.mjs';

export { memoryJournal } from './memory-journal.mjs';

const encode = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

export function fileJournal(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let seq = 0;
  return {
    file,
    write(type, data = {}) {
      const event = { seq: seq++, type, wall: new Date().toISOString(), ...data };
      fs.appendFileSync(file, JSON.stringify(event, encode) + '\n');
      return event;
    },
  };
}

export function readJournal(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}
