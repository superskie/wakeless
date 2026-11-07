// Reads a .env file (UTF-8 or UTF-16 LE) into an object, without touching
// process.env, except that a non-empty variable of the same name overrides
// the file. Node only: the web desk never imports this.
import fs from 'node:fs';

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
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
  for (const key of Object.keys(out)) {
    if (process.env[key] !== undefined && process.env[key] !== '') out[key] = process.env[key];
  }
  return out;
}
