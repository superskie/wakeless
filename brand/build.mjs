// Generates the Wakeless logo files from Instrument Serif, outlined to paths so no file depends
// on an installed font. With --site it also writes the favicon into web/ and the mark's path into
// the header of every page, so the site always shows what this script draws.
//
//   cd brand && npm install && npm run build            # brand/ files only
//   cd brand && npm install && npm run build -- --site  # and the site's favicon + headers
//
// Instrument Serif is under the SIL Open Font License 1.1.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FONTS = path.join(HERE, 'node_modules', '@fontsource', 'instrument-serif', 'files');

export const COLORS = {
  mint: '#5ee0c1', // --quiet on the site: the mark and every quiet state
  mintOnLight: '#1f9c82', // --quiet-deep: the mint above fails contrast on light grounds
  ink: '#edf2f7',
  inkOnLight: '#0b0f14',
  tile: '#0d1318',
  tileEdge: 'rgba(226,236,245,0.13)',
};

// The mark: the italic w of the headline's "No wake.", centred on its ink in a 64-unit square.
const MARK_WIDTH = 41; // ink width, in units of the 64 grid (44 crowded the tile's top and bottom)
const MARK_CENTER_Y = 32.4; // optical centre, a hair below the middle

const fmt = (n) => Number(n.toFixed(2));
function load(file) {
  const buf = readFileSync(path.join(FONTS, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
function toD(commands) {
  return commands.map((c) => {
    switch (c.type) {
      case 'M': case 'L': return `${c.type}${fmt(c.x)} ${fmt(c.y)}`;
      case 'Q': return `Q${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x)} ${fmt(c.y)}`;
      case 'C': return `C${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x)} ${fmt(c.y)}`;
      default: return 'Z';
    }
  }).join('');
}

export function markPath() {
  const italic = load('instrument-serif-latin-400-italic.woff');
  const glyph = italic.charToGlyph('w');
  if (glyph.unicode !== 'w'.charCodeAt(0)) throw new Error('the italic font has no w');
  const probe = glyph.getPath(0, 0, 100).getBoundingBox();
  const size = (100 * MARK_WIDTH) / (probe.x2 - probe.x1);
  const bb = glyph.getPath(0, 0, size).getBoundingBox();
  const p = glyph.getPath(32 - (bb.x1 + bb.x2) / 2, MARK_CENTER_Y - (bb.y1 + bb.y2) / 2, size);
  const box = p.getBoundingBox();
  return { d: toD(p.commands), box: [box.x1, box.y1, box.x2, box.y2].map(fmt) };
}

// The wordmark: "Wakeless" in Instrument Serif 400 with the font's kerning, as in the site header.
export function wordmarkPath() {
  const roman = load('instrument-serif-latin-400-normal.woff');
  const text = 'Wakeless';
  const glyphs = roman.stringToGlyphs(text, { features: { liga: false, rlig: false } });
  if (glyphs.length !== text.length) throw new Error(`expected ${text.length} glyphs, got ${glyphs.length}`);
  const size = 100;
  const scale = size / roman.unitsPerEm;
  let x = 0, d = '';
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  glyphs.forEach((g, i) => {
    const p = g.getPath(x, 0, size);
    d += toD(p.commands);
    const bb = p.getBoundingBox();
    if (bb.x1 < bb.x2) { x1 = Math.min(x1, bb.x1); x2 = Math.max(x2, bb.x2); y1 = Math.min(y1, bb.y1); y2 = Math.max(y2, bb.y2); }
    const next = glyphs[i + 1];
    x += g.advanceWidth * scale + (next ? roman.getKerningValue(g, next) * scale : 0);
  });
  // Cap height of the W, used to centre the word on the mark in the lockup.
  const W = glyphs[0].getPath(0, 0, size).getBoundingBox();
  return { d, box: [x1, y1, x2, y2].map(fmt), capTop: fmt(W.y1) };
}

const tileRect = (fill = COLORS.tile, edge = COLORS.tileEdge) => `<rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="${fill}" stroke="${edge}"/>`;
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

export function build() {
  const mark = markPath();
  const word = wordmarkPath();
  const files = {};

  files['wakeless-mark.svg'] = svg('0 0 64 64', `<path fill="${COLORS.mint}" d="${mark.d}"/>`);
  files['wakeless-mark-on-light.svg'] = svg('0 0 64 64', `<path fill="${COLORS.mintOnLight}" d="${mark.d}"/>`);
  files['wakeless-icon.svg'] = svg('0 0 64 64', `${tileRect()}<path fill="${COLORS.mint}" d="${mark.d}"/>`);
  // Full bleed: for platforms that crop the square themselves (X avatar circle, iOS home screen).
  files['wakeless-icon-square.svg'] = svg('0 0 64 64', `<rect width="64" height="64" fill="${COLORS.tile}"/><path fill="${COLORS.mint}" d="${mark.d}"/>`);

  const [wx1, wy1, wx2, wy2] = word.box;
  const pad = 2;
  const wordVB = [wx1 - pad, wy1 - pad, wx2 - wx1 + 2 * pad, wy2 - wy1 + 2 * pad].map(fmt).join(' ');
  files['wakeless-wordmark.svg'] = svg(wordVB, `<path fill="${COLORS.ink}" d="${word.d}"/>`);
  files['wakeless-wordmark-on-light.svg'] = svg(wordVB, `<path fill="${COLORS.inkOnLight}" d="${word.d}"/>`);

  // Lockup in the header's proportions: a 26 px tile, 24 px type, 10 px apart. The W's cap
  // height is centred on the tile.
  const k = (24 / 26) * (64 / 100); // wordmark units -> lockup units (tile = 64)
  const gap = (10 / 26) * 64;
  const capH = -word.capTop * k;
  const baseline = 32 + capH / 2;
  const tx = 64 + gap - wx1 * k;
  const width = fmt(64 + gap + (wx2 - wx1) * k + 1);
  const lockup = (ink) => svg(`0 0 ${width} 64`, `${tileRect()}<path fill="${COLORS.mint}" d="${mark.d}"/>`
    + `<path fill="${ink}" transform="translate(${fmt(tx)} ${fmt(baseline)}) scale(${fmt(k * 1000) / 1000})" d="${word.d}"/>`);
  files['wakeless-lockup.svg'] = lockup(COLORS.ink);
  files['wakeless-lockup-on-light.svg'] = lockup(COLORS.inkOnLight);

  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(HERE, name), body);
  return { mark, word, files: Object.keys(files) };
}

// The site: favicon.svg from the icon, and the mark's path in each page header
// (<path class="mark-w" d="...">).
export function applyToSite(mark) {
  writeFileSync(path.join(ROOT, 'web', 'favicon.svg'), readFileSync(path.join(HERE, 'wakeless-icon.svg')));
  const pages = ['home.html', 'index.html', '404.html'].map((f) => path.join(ROOT, 'web', f));
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const out = html.replace(/(<path class="mark-w" d=")[^"]*(")/g, `$1${mark.d}$2`);
    if (!/<path class="mark-w" d="/.test(out)) throw new Error(`${path.basename(page)} has no <path class="mark-w">`);
    writeFileSync(page, out);
  }
  return pages.map((p) => path.relative(ROOT, p));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mark, word, files } = build();
  console.log(`mark ink box ${mark.box.join(' ')}; wordmark box ${word.box.join(' ')}`);
  console.log(`wrote brand/${files.join(', brand/')}`);
  if (process.argv.includes('--site')) console.log(`site: web/favicon.svg, headers in ${applyToSite(mark).join(', ')}`);
}
