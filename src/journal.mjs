// Append-only JSONL journal. Every decision is written with the inputs that
// produced it, so a report can be rebuilt from the file alone.
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonl } from './memory-journal.mjs';

export { memoryJournal } from './memory-journal.mjs';

const encode = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

/**
 * A journal holds one run, so an existing file is refused rather than
 * appended to: a second run in the same file would break its report.
 */
export function fileJournal(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${file} already exists; a journal holds one run, so pick a new file name`);
    throw err;
  }
  let seq = 0;
  return {
    file,
    write(type, data = {}) {
      const event = { seq: seq++, type, wall: new Date().toISOString(), ...data };
      fs.writeSync(fd, JSON.stringify(event, encode) + '\n');
      return event;
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/**
 * The report that goes with a journal: run.jsonl gives run.md, any other name
 * gets .md added, so the report can never overwrite its journal. An existing
 * report is refused too, so a journal name can not point at a file it would
 * overwrite (README.jsonl next to README.md).
 */
export function reportPathFor(journalFile) {
  const report = journalFile.replace(/(\.jsonl)?$/i, '.md');
  if (path.resolve(report) === path.resolve(journalFile)) throw new Error(`the report would overwrite the journal ${journalFile}`);
  if (fs.existsSync(report)) throw new Error(`${report} already exists; pick a journal name whose report (${path.basename(report)}) is new`);
  return report;
}

export function readJournal(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}
