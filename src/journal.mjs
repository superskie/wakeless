// Append-only JSONL journal. Every decision is written with the inputs that
// produced it, so a report can be rebuilt from the file alone.
import fs from 'node:fs';
import path from 'node:path';

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

/** In-memory journal for tests; events round-trip through JSON like the file. */
export function memoryJournal() {
  const events = [];
  return {
    events,
    write(type, data = {}) {
      const event = JSON.parse(JSON.stringify({ seq: events.length, type, ...data }, encode));
      events.push(event);
      return event;
    },
  };
}

export function readJournal(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
