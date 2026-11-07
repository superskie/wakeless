// The hero's water, an illustration of the product in one loop. Lines in
// perspective make a calm surface. One large bar (one swap of the whole
// order) crosses it and leaves a V-shaped wake that spreads behind it. Then
// the same order crosses again as small bars of random sizes and times, and
// the water stays flat.
//
// Cheap on purpose: about 26 polylines at 30 frames per second, a cached
// horizon glow, paused when off screen or in a hidden tab, and one still
// frame (the calm crossing) when the visitor prefers reduced motion.

const TEAL = '94, 224, 193';
const KELVIN = 0.36; // tan(19.5 degrees), the half-angle of a ship's wake

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 * @param {number} [options.slices] how many slices cross after the swap
 * @param {number} [options.band] share of the canvas height the water fills;
 *   by default a band along the bottom sized for the desk's hero
 */
export function startWater(canvas, { slices = 16, band = null } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let horizon = 0;
  let lines = [];
  let glow = null;
  let story = null;
  let last = 0;
  let onScreen = true;

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const ease = (v) => v * v * (3 - 2 * v);

  function build() {
    // The water is a band along the bottom of the hero, under the copy.
    // One column below 1080 px: the hero keeps a taller empty strip for it.
    horizon = band
      ? height * (1 - band)
      : Math.max(height * 0.45, height - Math.min(width < 1080 ? 240 : 270, height * 0.42));
    const count = Math.max(14, Math.min(band ? 34 : 26, Math.round((height - horizon) / 10)));
    lines = Array.from({ length: count }, (_, i) => {
      const d = (i + 1) / count; // 0 far, 1 near
      return {
        d,
        y: horizon + (height - horizon) * d ** 1.65,
        amp: (0.4 + d * 1.6) * rand(0.7, 1.2),
        freq: rand(0.004, 0.009) / (0.6 + d),
        phase: rand(0, Math.PI * 2),
        speed: rand(0.07, 0.18),
        alpha: 0.035 + d * 0.11,
      };
    });

    glow = document.createElement('canvas');
    glow.width = Math.max(1, Math.round(width));
    glow.height = Math.max(1, Math.round(height));
    const g = glow.getContext('2d');
    // An elliptical glow on the horizon: a radial gradient squashed vertically,
    // so it fades out before any edge of the canvas.
    const r = width * 0.55;
    const halo = g.createRadialGradient(0, 0, 0, 0, 0, r);
    halo.addColorStop(0, `rgba(${TEAL}, 0.11)`);
    halo.addColorStop(0.5, `rgba(${TEAL}, 0.03)`);
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.save();
    g.translate(width * 0.5, horizon);
    g.scale(1, 0.22);
    g.fillStyle = halo;
    g.fillRect(-r, -r, 2 * r, 2 * r);
    g.restore();
    const edge = g.createLinearGradient(0, 0, width, 0);
    edge.addColorStop(0, 'rgba(255, 255, 255, 0)');
    edge.addColorStop(0.5, 'rgba(214, 255, 244, 0.35)');
    edge.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = edge;
    g.fillRect(0, horizon - 0.5, width, 1);

    // One slow loop, the same length at any width: the swap takes 24 seconds
    // to cross, its wake settles, then the slices drift across over about 16.
    const lane = 0.62;
    const k = Math.min(1, Math.max(0.6, width / 1200));
    const speed = (width + 160) / 24;
    const cross = (width + 160) / speed;
    const sliceStart = cross + 3;
    const parts = Array.from({ length: slices }, (_, i) => ({
      at: sliceStart + i * (16 / slices) + rand(0, 12 / slices),
      d: lane + rand(-0.07, 0.07),
      h: rand(5, 15) * k,
      v: speed * rand(0.95, 1.1),
    }));
    const lastOut = Math.max(...parts.map((p) => p.at + (width + 160) / p.v));
    story = { lane, k, speed, cross, parts, period: lastOut + 2 };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    draw(reduce ? story.cross + 22 : performance.now() / 1000);
  }

  const lineY = (line, x, t) => line.y + Math.sin(x * line.freq + line.phase + t * line.speed) * line.amp;
  const depthY = (d) => horizon + (height - horizon) * d ** 1.65;
  const scaleAt = (d) => 0.45 + d * 0.9;

  function draw(seconds) {
    const t = seconds % story.period;
    const { lane, k, speed, cross, parts } = story;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(glow, 0, 0, width, height);

    // The swap, and how strong its wake still is.
    const bx = -80 + t * speed;
    const level = t < cross ? 1 : 1 - ease(clamp01((t - cross) / 4));
    const boatY = depthY(lane);

    ctx.lineWidth = 1;
    const step = 10;
    const chunk = 8;
    const xs = [];
    for (let x = 0; x <= width + step; x += step) xs.push(x);
    const ys = new Float32Array(xs.length);
    const disp = new Float32Array(xs.length);
    for (const line of lines) {
      const z = (line.d - lane) * 520; // depth difference, in screen pixels at the lane
      const size = scaleAt(line.d);
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        let w = 0;
        const dx = bx - x;
        if (level > 0 && dx > 0) {
          const arm = Math.abs(z) - dx * KELVIN;
          const sigma = 10 + dx * 0.05;
          const g = Math.exp(-(arm * arm) / (2 * sigma * sigma));
          const inside = Math.abs(z) < dx * KELVIN ? 0.25 * Math.exp(-dx / 260) : 0;
          w = (g + inside) * Math.sin(dx * 0.06 - t * 0.9) * 6 * k * size * Math.exp(-dx / 650) * level;
        }
        disp[i] = w;
        ys[i] = lineY(line, x, seconds) + w;
      }
      const bowIndex = Math.ceil(bx / step);
      for (let c = 0; c < xs.length - 1; ) {
        let end = Math.min(xs.length - 1, c + chunk);
        if (c < bowIndex && end > bowIndex) end = bowIndex;
        let peak = 0;
        for (let i = c; i <= end; i++) peak = Math.max(peak, Math.abs(disp[i]));
        ctx.beginPath();
        ctx.moveTo(xs[c], ys[c]);
        for (let i = c + 1; i <= end; i++) ctx.lineTo(xs[i], ys[i]);
        ctx.strokeStyle = `rgba(${TEAL}, ${Math.min(0.45, line.alpha + peak * 0.04)})`;
        ctx.stroke();
        c = end;
      }
    }

    ctx.font = `500 ${k < 0.8 ? 10 : 11}px "Geist Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const label = (text, x, y) => {
      const w = ctx.measureText(text).width;
      ctx.fillText(text, Math.max(8, Math.min(x - w / 2, width - w - 8)), y);
    };

    if (bx > -40 && bx < width + 40) {
      const s = scaleAt(lane) * k;
      const h = 46 * s;
      const w = 9 * s;
      const top = boatY - h;
      const body = ctx.createLinearGradient(0, top, 0, boatY);
      body.addColorStop(0, 'rgba(236, 255, 249, 0.95)');
      body.addColorStop(1, `rgba(${TEAL}, 0.85)`);
      ctx.fillStyle = `rgba(${TEAL}, 0.12)`;
      ctx.fillRect(bx - w * 2, top - 6, w * 4, h + 10);
      ctx.fillStyle = body;
      ctx.fillRect(bx - w / 2, top, w, h);
      ctx.fillStyle = 'rgba(233, 238, 244, 0.6)';
      label('one swap', bx, top - 12);
    }

    let lead = null;
    for (const p of parts) {
      const x = -60 + (t - p.at) * p.v;
      if (x < -20 || x > width + 20) continue;
      const s = scaleAt(p.d);
      const y = depthY(p.d) + Math.sin(x * 0.006 + p.h) * 0.8;
      const h = p.h * s;
      ctx.fillStyle = `rgba(${TEAL}, 0.75)`;
      ctx.fillRect(x - 1.25, y - h, 2.5, h);
      if (!lead || x > lead.x) lead = { x, y: y - h };
    }
    if (lead) {
      ctx.fillStyle = `rgba(${TEAL}, 0.85)`;
      label(`${slices} slices, no wake`, lead.x, depthY(lane - 0.1) - 30 * k);
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!onScreen || document.hidden || ts - last < 33) return;
    last = ts;
    draw(ts / 1000);
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
  }).observe(canvas);
  resize();
  if (document.fonts) document.fonts.ready.then(() => reduce && draw(story.cross + 22));
  if (!reduce) requestAnimationFrame(frame);
}
