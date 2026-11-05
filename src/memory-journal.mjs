// In-memory journal with no Node imports, so the browser can use it too.
// Events round-trip through JSON exactly like the file journal, so bigint
// amounts arrive as strings and a report can be built from them directly.

const encode = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

export function memoryJournal() {
  const events = [];
  return {
    events,
    write(type, data = {}) {
      const event = JSON.parse(JSON.stringify({ seq: events.length, type, wall: new Date().toISOString(), ...data }, encode));
      events.push(event);
      return event;
    },
  };
}

/** Events as JSONL text, the same format as the file journal. */
export function toJsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

/** Parse JSONL text back into events. */
export function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
