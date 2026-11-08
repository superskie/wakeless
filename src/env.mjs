// Reads a .env file (UTF-8 or UTF-16 LE) into an object, without touching
// process.env, except that a non-empty variable of the same name overrides
// the file. Node only: the web desk never imports this.
import fs from 'node:fs';

/** PowerShell 5's `>` writes UTF-16 LE with an FF FE byte order mark. */
const isUtf16le = (buf) => buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;

/**
 * @param {string} file
 * @param {{ overrides?: boolean }} [opts] `overrides: false` reads the file
 *   alone, without the environment's values
 */
export function readEnvFile(file, { overrides = true } = {}) {
  if (!fs.existsSync(file)) return {};
  const buf = fs.readFileSync(file);
  const text = isUtf16le(buf) ? buf.toString('utf16le') : buf.toString('utf8');
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  if (!overrides) return out;
  for (const key of Object.keys(out)) {
    if (process.env[key] !== undefined && process.env[key] !== '') out[key] = process.env[key];
  }
  return out;
}

/**
 * Keys, tokens and ids go into HTTP headers, where a stray CR, a space or a
 * non-ASCII letter makes fetch throw an error that quotes the whole value.
 * So a secret must be printable ASCII (0x21 to 0x7e); the error names the
 * variable, never the value.
 */
export function checkSecret(name, value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${name} holds a character that is not printable ASCII (a space, a stray CR from a paste, a quote mark?); fix that line in .env`);
  }
  return value;
}

/**
 * Append KEY=value lines to a .env file in the file's own encoding (UTF-16 LE
 * when it starts with FF FE, else UTF-8), then read them back: a value that
 * does not read back is reported, so nobody acts on a key that was not kept.
 * Refuses a key that already has a value.
 */
export function appendEnvFile(file, entries, comment) {
  const current = readEnvFile(file, { overrides: false });
  const lines = [];
  for (const [key, value] of Object.entries(entries)) {
    if (current[key]) throw new Error(`${key} is already set in .env; remove it first to replace it`);
    lines.push(`${key}=${value}`);
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  const utf16 = isUtf16le(before);
  const text = utf16 ? before.toString('utf16le') : before.toString('utf8');
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  const added = `${prefix}${comment ? `# ${comment}\n` : ''}${lines.join('\n')}\n`;
  fs.appendFileSync(file, utf16 ? Buffer.from(added, 'utf16le') : added);
  const after = readEnvFile(file, { overrides: false });
  for (const [key, value] of Object.entries(entries)) {
    if (after[key] !== String(value)) {
      throw new Error(`${key} was appended to ${file} but does not read back; check the file's encoding and add the line by hand`);
    }
  }
}
