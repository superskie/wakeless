// Still water behind the hero: thin lines with a slow swell, and a few slices
// gliding across without leaving a wake. Cheap on purpose: about 25 polylines
// at 30 frames per second, paused when off screen or in a hidden tab.

export function startWater(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let lines = [];
  let ticks = [];
  let last = 0;
  let onScreen = true;

  const rand = (a, b) => a + Math.random() * (b - a);

  function build() {
    const count = Math.max(8, Math.round(height / 18));
    lines = Array.from({ length: count }, (_, i) => ({
      y: ((i + 0.5) * height) / count,
      amp: rand(0.6, 1.8),
      freq: rand(0.003, 0.008),
      phase: rand(0, Math.PI * 2),
      speed: rand(0.12, 0.35),
      alpha: rand(0.05, 0.12),
    }));
    ticks = Array.from({ length: 9 }, () => ({
      x: rand(0, width),
      line: Math.floor(rand(0, lines.length)),
      v: rand(0.25, 0.7),
      h: rand(5, 16),
    }));
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
    draw(performance.now());
  }

  function yAt(line, x, t) {
    return line.y + Math.sin(x * line.freq + line.phase + t * line.speed) * line.amp;
  }

  function draw(ts) {
    const t = ts / 1000;
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    for (const line of lines) {
      ctx.beginPath();
      for (let x = 0; x <= width + 12; x += 12) {
        const y = yAt(line, x, t);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(94, 224, 193, ${line.alpha})`;
      ctx.stroke();
    }
    for (const tick of ticks) {
      const line = lines[tick.line];
      if (!line) continue;
      const y = yAt(line, tick.x, t);
      ctx.fillStyle = 'rgba(94, 224, 193, 0.5)';
      ctx.fillRect(tick.x, y - tick.h, 2, tick.h);
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!onScreen || document.hidden || ts - last < 33) return;
    last = ts;
    for (const tick of ticks) {
      tick.x += tick.v;
      if (tick.x > width + 10) {
        tick.x = -10;
        tick.line = Math.floor(rand(0, lines.length));
      }
    }
    draw(ts);
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
  }).observe(canvas);
  resize();
  if (!reduce) requestAnimationFrame(frame);
}
