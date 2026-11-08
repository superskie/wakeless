# Wakeless brand

**Wakeless**: a large swap moves the price and leaves a pattern that watchers trade against,
the way a boat leaves a wake. Wakeless works the order as random confidential slices, so the
water stays flat. Line: *Big trades. No wake.* Capitalised in prose and in the wordmark.

## Mark

The italic w of the headline's *No wake.*, in the quiet mint, on a near-black tile. It is the
first letter of the word the brand is about, set in the type every visitor reads first, so the
mark and the landing speak in one voice. Outlined from Instrument Serif Italic 400; no file
depends on an installed font.

| File | Use |
|---|---|
| `wakeless-icon.svg` | rounded tile with the w: favicon, listings, anywhere a square icon goes |
| `wakeless-icon-square.svg` | full-bleed square, for platforms that crop it themselves (X circle, iOS) |
| `wakeless-icon-512.png` | the icon as PNG, for forms that want a raster file |
| `wakeless-mark.svg` | the w alone, transparent, mint |
| `wakeless-mark-on-light.svg` | the w alone in deep mint, for light grounds |
| `wakeless-wordmark.svg`, `wakeless-wordmark-on-light.svg` | "Wakeless" in Instrument Serif 400, outlined |
| `wakeless-lockup.svg`, `wakeless-lockup-on-light.svg` | icon + wordmark in the site header's proportions (26 px tile, 24 px type, 10 px gap) |
| `x/wakeless-x-avatar.png` | X profile photo, 800×800, full bleed for the circle crop |
| `wakeless-banner.png` | README banner, 2560×880 (1280×440 at 2x), rendered from `web/dev/banner.html` with the landing's water scene |

On the site: `web/favicon.svg` (copy of the icon), `web/favicon.ico` (16, 32, 48 px),
`web/apple-touch-icon.png` (180 px, full bleed), and the mark's path inline in the header of
`web/home.html`, `web/index.html` and `web/404.html` (`<path class="mark-w">`). The link card
`web/assets/og-v2.png` is rendered from `web/dev/og.html` with the same icon.

Regenerate:

```sh
cd brand && npm install && npm run build -- --site
```

`build.mjs` writes every SVG here and, with `--site`, the favicon and the header paths. The
PNGs and the ICO are rasterised from the SVGs in a browser (canvas `drawImage` at each size;
Pillow packs the ICO). `MARK_WIDTH` and `MARK_CENTER_Y` in `build.mjs` set the w's size and
optical centre in the 64-unit tile.

## Colour

From the site's tokens (`web/style.css`, `web/home.css`):

| Token | Hex | Rule |
|---|---|---|
| Background | `#07090c` | page |
| Tile | `#0d1318` | the icon's ground, panels |
| Ink | `#edf2f7` | text, the wordmark on dark |
| Muted | `#7b8795` | secondary text |
| Quiet mint | `#5ee0c1` | the mark, actions, live state, anything quiet (slices, a flat surface) |
| Deep mint | `#1f9c82` | the mint on light grounds; `#5ee0c1` is too pale there |
| Amber | `#f2b84b` | the guard waits |
| Blue | `#7cc4ff` | the guard splits a slice |
| Coral | `#ff7a6b` | exposure: the public leak, danger |

Rules:
- Mint means quiet. A coral or amber thing is never drawn in mint, and the mark is never
  recoloured beyond the on-light variant.
- Type: Instrument Serif for display and the wordmark, with one italic phrase per headline in
  mint; Geist for words; Geist Mono for numbers, addresses and small labels.
- The icon is not used below 16 px. At 16 px it is the tile file, not the bare w.

## Directions tried and dropped

Kept so they are not explored again. Boards: `logo-v1.html` (nine directions) to
`logo-v7.html` (the final board, also as `logo-v7.png`). Open them through `npm run web`.

- Bars on a line (the first mark): a bar chart icon, the more so next to the desk's cost chart.
- Whale tail diving into flat water: the best story, but at 16 px and on light it reads as a
  sprout, and Whale Tail ($TAIL) and $WHALETAIL already trade on whale marks. Cutting the tail
  into slices made it read as an eagle's wings.
- Iceberg (tip above flat water, the mass below): the trading term for exactly this order type,
  but iceberg.cash, a trading desk on Hyperliquid markets, uses almost the same mark.
- Coin cut into slices of random width: a striped teal disc on dark reads as Jupiter.
- Arch of five stones whose reflection closes the circle: a gear or a loading spinner.
- Porthole with a calm horizon: a clock. Hull built from slices: a comb. Slices with
  reflections: an audio equaliser. The w with its reflection: noise at 16 px.
- Geometric W cut at the joints: legible but generic, and close to WalletConnect's W, which
  appears on the same page when a wallet connects.
