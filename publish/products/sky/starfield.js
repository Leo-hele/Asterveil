import { skyPosition } from './sky-motion.js?v=1';

// Decorative sky under the gallery. Its gestures and links stay independent.
const canvas = document.querySelector('.starfield');
const ctx = canvas?.getContext('2d');

if (ctx) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(any-pointer: fine)');
  const TAU = Math.PI * 2;
  const LINK_LIFE = 2600;
  const MAX_LINKS = 24;
  const colors = ['216,234,255', '240,243,255', '208,192,255'];
  const backdrop = document.createElement('canvas');
  backdrop.className = 'starfield-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  canvas.before(backdrop);
  const links = new Map();
  const cursor = { x: 0, y: 0, time: -Infinity, inside: false };
  const parallax = { x: 0, y: 0 };
  let stars = [];
  let groups = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastFrame = 0;
  let clock = 0;
  let lastWeave = 0;
  let lastStar = null;
  let meteor = null;
  let nextMeteor = 4500;
  let suspended = false;
  let geometryDirty = true;
  let resizeTimer = 0;

  const clamp = (value) => Math.max(0, Math.min(1, value));
  const smooth = (value) => {
    const t = clamp(value);
    return t * t * (3 - 2 * t);
  };
  const enabled = () => !document.hidden && !suspended;
  const seeded = (initial) => {
    let seed = initial;
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  };
  const random = seeded(59337);

  // Cache the luminous halos instead of constructing hundreds of gradients per frame.
  const glows = colors.map((color) => {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const brush = sprite.getContext('2d');
    const glow = brush.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, `rgba(${color},.85)`);
    glow.addColorStop(0.09, `rgba(${color},.48)`);
    glow.addColorStop(0.25, `rgba(${color},.12)`);
    glow.addColorStop(1, `rgba(${color},0)`);
    brush.fillStyle = glow;
    brush.fillRect(0, 0, 64, 64);
    return sprite;
  });

  function noise(x, y) {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = smooth(x - ix),
      fy = smooth(y - iy);
    const hash = (a, b) => {
      let n = Math.imul(a, 374761393) + Math.imul(b, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const top = hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx;
    const bottom = hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  function cloud(x, y) {
    return (
      noise(x, y) * 0.53 +
      noise(x * 2.1 + 17, y * 2.1) * 0.27 +
      noise(x * 4.3, y * 4.3 + 9) * 0.13 +
      noise(x * 8.7, y * 8.7) * 0.07
    );
  }

  function buildBackdrop() {
    backdrop.width = width + 96;
    backdrop.height = height + 96;
    const brush = backdrop.getContext('2d');
    const haze = document.createElement('canvas');
    haze.width = Math.ceil(backdrop.width / 5);
    haze.height = Math.ceil(backdrop.height / 5);
    const hazeBrush = haze.getContext('2d');
    const pixels = hazeBrush.createImageData(haze.width, haze.height);
    for (let y = 0; y < haze.height; y++) {
      for (let x = 0; x < haze.width; x++) {
        const u = x / haze.width,
          v = y / haze.height;
        const warp = cloud(u * 4 + 7, v * 3 + 3);
        const ribbon = v - (0.92 - u * 1.12 + (warp - 0.5) * 0.34);
        const band = Math.exp((-ribbon * ribbon) / 0.035);
        const texture = cloud(u * 9 + warp * 2, v * 7 + warp);
        const dust = Math.max(0, texture - 0.29) * 2.1;
        const density = band * dust * (0.7 + 0.3 * noise(u * 22, v * 22));
        const violet = smooth((warp - 0.38) * 3);
        const i = (y * haze.width + x) * 4;
        pixels.data[i] = density * (9 + violet * 13);
        pixels.data[i + 1] = density * (18 - violet * 5);
        pixels.data[i + 2] = density * (39 + violet * 8);
        pixels.data[i + 3] = 255;
      }
    }
    hazeBrush.putImageData(pixels, 0, 0);
    brush.drawImage(haze, 0, 0, backdrop.width, backdrop.height);
    const rng = seeded(4301);
    const count = Math.min(1700, Math.round((width * height) / 1250));
    for (let i = 0; i < count; i++) {
      const x = rng() * backdrop.width,
        y = rng() * backdrop.height;
      const radius = 0.25 + rng() ** 2 * 0.65;
      brush.fillStyle = `rgba(201,215,243,${0.16 + rng() * 0.48})`;
      brush.beginPath();
      brush.arc(x, y, radius, 0, TAU);
      brush.fill();
    }
  }

  function glowPoint(star, alpha, energy = 0) {
    const radius = star.radius + energy * 0.5;
    if (star.radius > 1 || energy > 0.05) {
      const size = radius * (12 + energy * 9);
      ctx.globalAlpha = alpha * (0.48 + energy * 0.35);
      ctx.drawImage(glows[star.color], star.px - size / 2, star.py - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(${colors[star.color]},${clamp(alpha)})`;
    ctx.beginPath();
    ctx.arc(star.px, star.py, radius, 0, TAU);
    ctx.fill();
    if (star.radius > 1.5 || energy > 0.65) {
      const arm = radius * (2.4 + energy * 1.8);
      ctx.strokeStyle = `rgba(221,234,255,${alpha * 0.25})`;
      ctx.lineWidth = 0.55;
      ctx.beginPath();
      ctx.moveTo(star.px - arm, star.py);
      ctx.lineTo(star.px + arm, star.py);
      ctx.moveTo(star.px, star.py - arm);
      ctx.lineTo(star.px, star.py + arm);
      ctx.stroke();
    }
  }

  function lightLine(a, b, alpha, progress = 1, spark = false) {
    if (alpha < 0.005 || progress <= 0) return;
    // Wrapped stars must never leave a line across the entire screen.
    if (Math.hypot(a.px - b.px, a.py - b.py) > 210) return;
    const x = a.px + (b.px - a.px) * progress;
    const y = a.py + (b.py - a.py) * progress;
    const gradient = ctx.createLinearGradient(a.px, a.py, b.px, b.py);
    gradient.addColorStop(0, `rgba(178,199,255,${alpha * 0.35})`);
    gradient.addColorStop(0.5, `rgba(211,229,255,${alpha})`);
    gradient.addColorStop(1, `rgba(203,190,255,${alpha * 0.5})`);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(x, y);
    ctx.strokeStyle = `rgba(136,173,255,${alpha * 0.1})`;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (spark && progress < 1) {
      glowPoint({ px: x, py: y, radius: 0.8, color: 0 }, alpha, 0.7);
    }
  }

  function weave(now) {
    if (!cursor.inside || now - cursor.time > 130 || now - lastWeave < 55) return;
    lastWeave = now;
    const closest = [];
    for (const star of stars) {
      const distance = (star.px - cursor.x) ** 2 + (star.py - cursor.y) ** 2;
      if (distance >= 145 ** 2) continue;
      const index = closest.findIndex((item) => distance < item.distance);
      closest.splice(index < 0 ? closest.length : index, 0, { star, distance });
      if (closest.length > 4) closest.pop();
    }
    const nearby = closest.map((item) => item.star);
    const connect = (a, b) => {
      if (!a || !b || a === b || Math.hypot(a.px - b.px, a.py - b.py) > 175) return;
      const key = [a.id, b.id].sort((x, y) => x - y).join(':');
      const old = links.get(key);
      links.set(key, { a, b, born: old?.born ?? now, touched: now });
    };
    nearby.forEach((star) => {
      star.lit = now;
    });
    if (nearby[0]) {
      connect(lastStar, nearby[0]);
      connect(nearby[0], nearby[1]);
      connect(nearby[1], nearby[2]);
      lastStar = nearby[0];
    }
    while (links.size > MAX_LINKS) links.delete(links.keys().next().value);
  }

  function drawMeteor(dt, still) {
    if (still) return;
    if (!meteor && clock > nextMeteor) {
      meteor = {
        x: width * (0.015 + random() * 0.08),
        y: height * (0.32 + random() * 0.24),
        age: 0,
        size: Math.min(width, height) / 850,
      };
      nextMeteor = clock + 13000 + random() * 10000;
    }
    if (!meteor) return;
    meteor.age += dt;
    const age = meteor.age / 1250;
    if (age >= 1) {
      meteor = null;
      return;
    }
    const fade = smooth(age / 0.12) * (1 - smooth((age - 0.55) / 0.45));
    const scale = Math.max(0.5, meteor.size);
    const x = meteor.x + age * 370 * scale,
      y = meteor.y + age * 190 * scale;
    const tail = Math.min(1, age * 5) * 115 * scale;
    const endX = x - tail,
      endY = y - tail * 0.514;
    const gradient = ctx.createLinearGradient(endX, endY, x, y);
    gradient.addColorStop(0, 'rgba(143,170,255,0)');
    gradient.addColorStop(0.7, `rgba(167,196,255,${fade * 0.22})`);
    gradient.addColorStop(1, `rgba(239,246,255,${fade * 0.85})`);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(x, y);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = gradient;
    ctx.stroke();
    glowPoint({ px: x, py: y, radius: 0.9, color: 0 }, fade, 0.75);
  }

  function paint(now, dt = 0, still = false) {
    ctx.clearRect(0, 0, width, height);
    const seconds = clock / 1000;
    const targetX = cursor.inside && !still ? (cursor.x / width - 0.5) * 18 : 0;
    const targetY = cursor.inside && !still ? (cursor.y / height - 0.5) * 18 : 0;
    const easing = 1 - Math.exp(-dt / 230);
    parallax.x += (targetX - parallax.x) * easing;
    parallax.y += (targetY - parallax.y) * easing;
    for (const group of groups) {
      const [x, y] = skyPosition(
        group.x * width,
        group.y * height,
        still ? 0 : seconds,
        0.65,
        width,
        height,
        200,
      );
      group.dx = x - group.x * width;
      group.dy = y - group.y * height;
    }
    for (const star of stars) {
      const [x, y] = star.group
        ? [star.x + star.group.dx, star.y + star.group.dy]
        : skyPosition(star.x, star.y, still ? 0 : seconds, star.depth, width, height);
      star.px = x + parallax.x * star.depth;
      star.py = y + parallax.y * star.depth;
    }
    if (!still) weave(now);
    for (const group of groups) {
      const age = (seconds + group.phase) % 25;
      const presence = still ? 0.3 : smooth(age / 2) * (1 - smooth((age - 10) / 5));
      group.edges.forEach(([a, b], index) => {
        const trace = still ? 1 : smooth((age - 1 - index * 0.7) / 1.2);
        lightLine(group.points[a], group.points[b], presence * 0.42, trace, true);
      });
    }
    for (const [key, link] of links) {
      const age = now - link.touched;
      if (age > LINK_LIFE) {
        links.delete(key);
        continue;
      }
      const fade = (1 - age / LINK_LIFE) ** 1.6;
      lightLine(link.a, link.b, fade * 0.75, smooth((now - link.born) / 240), true);
    }
    for (const star of stars) {
      const energy = still ? 0 : clamp(1 - (now - star.lit) / 2100) ** 1.7;
      const twinkle = still ? 0.85 : 0.77 + 0.23 * Math.sin(seconds * star.speed + star.phase);
      glowPoint(star, Math.min(1, star.alpha * twinkle + energy * 0.7), energy);
    }
    drawMeteor(dt, still);
  }

  function animate(now) {
    frame = 0;
    if (!enabled() || reducedMotion.matches) return;
    // Slow drift needs 30 fps; pointer interaction retains up to 60 fps.
    const interval = cursor.inside && now - cursor.time < 700 ? 1000 / 60 : 1000 / 30;
    if (lastFrame && now - lastFrame < interval - 1) {
      frame = requestAnimationFrame(animate);
      return;
    }
    const dt = lastFrame ? Math.min(now - lastFrame, 100) : interval;
    lastFrame = now;
    clock += dt;
    paint(now, dt);
    frame = requestAnimationFrame(animate);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
    lastStar = null;
    cursor.inside = false;
    parallax.x = parallax.y = 0;
    links.clear();
    meteor = null;
    stars.forEach((star) => {
      star.lit = -Infinity;
    });
    backdrop.style.animationPlayState = enabled() && !reducedMotion.matches ? 'running' : 'paused';
    if (!enabled()) return;
    if (geometryDirty) prepareGeometry();
    paint(performance.now(), 0, reducedMotion.matches);
    if (!reducedMotion.matches) frame = requestAnimationFrame(animate);
  }

  function prepareGeometry() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(3000000 / (width * height)));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'round';
    buildBackdrop();
    const rng = seeded(7731);
    const count = Math.min(310, Math.max(85, Math.round((width * height) / 6100)));
    stars = Array.from({ length: count }, (_, id) => ({
      id,
      x: rng() * width,
      y: rng() * height,
      px: 0,
      py: 0,
      radius: 0.55 + rng() ** 3 * 1.2,
      alpha: 0.38 + rng() * 0.54,
      depth: 0.2 + rng() * 0.8,
      phase: rng() * TAU,
      speed: 0.4 + rng() * 0.9,
      color: Math.floor(rng() * colors.length),
      lit: -Infinity,
    }));
    const patterns = [
      {
        x: 0.17,
        y: 0.59,
        size: 245,
        phase: 3,
        points: [
          [-0.5, -0.2],
          [-0.24, 0.2],
          [0, -0.12],
          [0.23, 0.28],
          [0.5, -0.3],
        ],
        edges: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
        ],
      },
      {
        x: 0.075,
        y: 0.23,
        size: 165,
        phase: 15,
        points: [
          [-0.28, -0.5],
          [0.05, -0.32],
          [-0.09, 0.04],
          [0.27, 0.15],
          [0.1, 0.48],
          [-0.24, 0.32],
        ],
        edges: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 2],
        ],
      },
      {
        x: 0.83,
        y: 0.83,
        size: 265,
        phase: 9,
        points: [
          [-0.5, -0.22],
          [-0.28, -0.28],
          [-0.05, -0.09],
          [0.12, 0.2],
          [0.4, 0.18],
          [0.5, -0.15],
          [0.16, -0.2],
        ],
        edges: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 6],
          [6, 3],
        ],
      },
    ];
    const scale = Math.max(0.48, Math.min(1.2, width / 1300, height / 750));
    groups = patterns.map((pattern) => ({
      ...pattern,
      points: pattern.points.map(([x, y], index) => {
        const star = {
          id: stars.length,
          x: pattern.x * width + x * pattern.size * scale,
          y: pattern.y * height + y * pattern.size * scale,
          px: 0,
          py: 0,
          radius: index % 3 ? 1.1 : 1.6,
          alpha: 0.85,
          depth: 0.65,
          phase: rng() * TAU,
          speed: 0.5,
          color: index % 3,
          lit: -Infinity,
        };
        stars.push(star);
        return star;
      }),
    }));
    groups.forEach((group) => {
      group.points.forEach((star) => {
        star.group = group;
      });
    });
    geometryDirty = false;
  }

  addEventListener(
    'pointermove',
    (event) => {
      if (
        !enabled() ||
        reducedMotion.matches ||
        !finePointer.matches ||
        event.pointerType === 'touch'
      )
        return;
      const now = performance.now();
      if (
        now - cursor.time > 220 ||
        Math.hypot(event.clientX - cursor.x, event.clientY - cursor.y) > 220
      )
        lastStar = null;
      cursor.x = event.clientX;
      cursor.y = event.clientY;
      cursor.time = now;
      cursor.inside = true;
    },
    { passive: true },
  );
  const leave = () => {
    cursor.inside = false;
    lastStar = null;
  };
  document.addEventListener('pointerleave', leave);
  addEventListener('blur', leave);
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      geometryDirty = true;
      sync();
    }, 120);
  });
  document.addEventListener('visibilitychange', sync);
  addEventListener('pagehide', () => {
    suspended = true;
    sync();
  });
  addEventListener('pageshow', () => {
    suspended = false;
    sync();
  });
  reducedMotion.addEventListener('change', sync);
  sync();
}
