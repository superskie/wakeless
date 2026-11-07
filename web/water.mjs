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

export function startWater(canvas, { slices = 16 } = {}) {
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
    horizon = Math.max(height * 0.45, height - Math.min(270, height * 0.42));
    const count = Math.max(14, Math.min(26, Math.round((height - horizon) / 10)));
    lines = Array.from({ length: count }, (_, i) => {
      const d = (i + 1) / count; // 0 far, 1 near
      return {
        d,
        y: horizon + (height - horizon) * d ** 1.65,
        amp: (0.4 + d * 1.6) * rand(0.7, 1.2),
        freq: rand(0.004, 0.009) / (0.6 + d),
        phase: rand(0, Math.PI * 2),
        speed: rand(0.15, 0.4),
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

    // One loop: the swap crosses, its wake fades, then the slices cross.
    const lane = 0.5;
    const speed = Math.max(120, width / 7.5);
    const cross = (width + 160) / speed;
    const sliceStart = cross + 1.6;
    const parts = Array.from({ length: slices }, (_, i) => ({
      at: sliceStart + i * 0.34 + rand(0, 0.28),
      d: lane + rand(-0.07, 0.07),
      h: rand(5, 15),
      v: speed * rand(1.05, 1.25),
    }));
    const lastOut = Math.max(...parts.map((p) => p.at + (width + 160) / p.v));
    story = { lane, speed, cross, parts, period: lastOut + 1.2 };
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
    draw(reduce ? story.cross + 4.5 : performance.now() / 1000);
  }

  const lineY = (line, x, t) => line.y + Math.sin(x * line.freq + line.phase + t * line.speed) * line.amp;
  const depthY = (d) => horizon + (height - horizon) * d ** 1.65;
  const scaleAt = (d) => 0.45 + d * 0.9;

  function draw(seconds) {
    const t = seconds % story.period;
    const { lane, speed, cross, parts } = story;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(glow, 0, 0, width, height);

    // The swap, and how strong its wake still is.
    const bx = -80 + t * speed;
    const level = t < cross ? 1 : 1 - ease(clamp01((t - cross) / 2.4));
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
          w = (g + inside) * Math.sin(dx * 0.075 - t * 3.2) * 9 * size * Math.exp(-dx / 650) * level;
        }
        disp[i] = w;
        ys[i] = lineY(line, x, seconds) + w;
      }
      for (let c = 0; c < xs.length - 1; c += chunk) {
        const end = Math.min(xs.length - 1, c + chunk);
        let peak = 0;
        for (let i = c; i <= end; i++) peak = Math.max(peak, Math.abs(disp[i]));
        ctx.beginPath();
        ctx.moveTo(xs[c], ys[c]);
        for (let i = c + 1; i <= end; i++) ctx.lineTo(xs[i], ys[i]);
        ctx.strokeStyle = `rgba(${TEAL}, ${Math.min(0.6, line.alpha + peak * 0.045)})`;
        ctx.stroke();
      }
    }

    ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';

    if (bx > -40 && bx < width + 40) {
      const s = scaleAt(lane);
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
      ctx.fillText('one swap', bx - 26, top - 12);
    }

    let lead = null;
    for (const p of parts) {
      const x = -60 + (t - p.at) * p.v;
      if (x < -20 || x > width + 20) continue;
      const s = scaleAt(p.d);
      const y = depthY(p.d) + Math.sin(x * 0.006 + p.h) * 0.8;
      const h = p.h * s;
      ctx.fillStyle = `rgba(${TEAL}, 0.75)`;
      ctx.fillRect(x - 1.5, y - h, 3, h);
      if (!lead || x > lead.x) lead = { x, y: y - h };
    }
    if (lead) {
      ctx.fillStyle = `rgba(${TEAL}, 0.85)`;
      ctx.fillText(`${slices} slices, no wake`, Math.min(lead.x - 40, width - 150), depthY(lane - 0.1) - 30);
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
  if (document.fonts) document.fonts.ready.then(() => reduce && draw(story.cross + 4.5));
  if (!reduce) requestAnimationFrame(frame);
}
