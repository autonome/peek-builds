/**
 * Help Docs Overlay Animation Script
 *
 * Renders organic animated strands that creep in from screen edges,
 * undulate gently, and flee from the cursor.
 *
 * Each strand is a chain of segments rendered as a smooth bezier curve.
 * Control points animate with sinusoidal wobble for organic motion.
 * Cursor proximity triggers a fear/recoil response.
 */

const canvas = document.getElementById('overlay-canvas');
const ctx = canvas.getContext('2d');

// --- Configuration ---
const CONFIG = {
  // Spawn timing
  spawnIntervalMin: 3000,    // 3s minimum between spawns
  spawnIntervalMax: 8000,    // 8s maximum between spawns

  // Strand properties
  minSegments: 6,
  maxSegments: 14,
  minSegmentLength: 12,
  maxSegmentLength: 28,
  minThickness: 3,
  maxThickness: 12,

  // Animation
  creepSpeed: 0.8,           // pixels per frame when creeping in
  retreatSpeed: 0.15,        // pixels per frame when retreating naturally
  fleeSpeed: 3.0,            // pixels per frame when fleeing from cursor
  wobbleSpeed: 0.02,         // radians per frame for sinusoidal wobble
  wobbleAmplitude: 0.15,     // max radians of wobble per segment

  // Lifecycle
  creepInDuration: 3000,     // ms to creep in
  lingerDurationMin: 4000,   // ms to linger at max extension
  lingerDurationMax: 10000,  // ms to linger at max extension
  retreatDuration: 4000,     // ms to retreat

  // Fear response
  fearRadius: 100,           // px distance to trigger fear
  fearRecoveryTime: 2000,    // ms before strand can return after fear

  // Visual
  maxAlpha: 0.7,
  colors: [
    { r: 90, g: 60, b: 120 },   // muted purple
    { r: 60, g: 90, b: 80 },    // dark teal
    { r: 70, g: 70, b: 100 },   // slate blue
    { r: 80, g: 60, b: 90 },    // dusty violet
    { r: 50, g: 80, b: 70 },    // deep sea green
  ],

  // Max simultaneous strands
  maxStrands: 12,
};

// --- State ---
let strands = [];
let mouseX = -1000;
let mouseY = -1000;
let animationId = null;
let spawnTimer = null;
let lastTime = 0;

// --- Edge enum ---
const EDGE = { TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3 };

// --- Utility ---
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dist = (x1, y1, x2, y2) => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

/**
 * Create a new strand emerging from a random edge
 */
function createStrand() {
  const edge = randInt(0, 3);
  const numSegments = randInt(CONFIG.minSegments, CONFIG.maxSegments);
  const segmentLength = rand(CONFIG.minSegmentLength, CONFIG.maxSegmentLength);
  const thickness = rand(CONFIG.minThickness, CONFIG.maxThickness);
  const color = CONFIG.colors[randInt(0, CONFIG.colors.length - 1)];

  // Base position along the edge
  let baseX, baseY, angle;
  const W = canvas.width;
  const H = canvas.height;
  const margin = 80;

  switch (edge) {
    case EDGE.TOP:
      baseX = rand(margin, W - margin);
      baseY = 0;
      angle = Math.PI / 2 + rand(-0.3, 0.3); // mostly downward
      break;
    case EDGE.BOTTOM:
      baseX = rand(margin, W - margin);
      baseY = H;
      angle = -Math.PI / 2 + rand(-0.3, 0.3); // mostly upward
      break;
    case EDGE.LEFT:
      baseX = 0;
      baseY = rand(margin, H - margin);
      angle = rand(-0.3, 0.3); // mostly rightward
      break;
    case EDGE.RIGHT:
      baseX = W;
      baseY = rand(margin, H - margin);
      angle = Math.PI + rand(-0.3, 0.3); // mostly leftward
      break;
  }

  // Each segment has a base angle offset and a wobble phase
  const segments = [];
  for (let i = 0; i < numSegments; i++) {
    segments.push({
      length: segmentLength * (1 - i * 0.03), // taper slightly
      angleOffset: rand(-0.15, 0.15),          // slight random curvature
      wobblePhase: rand(0, Math.PI * 2),       // random initial phase
      wobbleFreq: rand(0.6, 1.4),              // varied wobble frequency
    });
  }

  const lingerDuration = rand(CONFIG.lingerDurationMin, CONFIG.lingerDurationMax);

  return {
    edge,
    baseX,
    baseY,
    baseAngle: angle,
    segments,
    thickness,
    color,
    numSegments,

    // Extension: 0 = fully retracted, 1 = fully extended
    extension: 0,
    targetExtension: 1,

    // Lifecycle phase: 'creeping', 'lingering', 'retreating', 'dead'
    phase: 'creeping',
    phaseTime: 0,
    lingerDuration,

    // Fear state
    afraid: false,
    fearTime: 0,

    // Wobble time accumulator
    wobbleTime: rand(0, 100),

    // Alpha
    alpha: 0,
  };
}

/**
 * Compute the joint positions of a strand
 * Returns array of {x, y} points from base to tip
 */
function computePoints(s) {
  const points = [{ x: s.baseX, y: s.baseY }];
  let currentAngle = s.baseAngle;
  let x = s.baseX;
  let y = s.baseY;

  // Only draw segments up to current extension
  const visibleSegments = Math.ceil(s.extension * s.numSegments);
  const partialFrac = (s.extension * s.numSegments) - Math.floor(s.extension * s.numSegments);

  for (let i = 0; i < visibleSegments && i < s.segments.length; i++) {
    const seg = s.segments[i];

    // Wobble: sinusoidal oscillation that propagates down the strand
    const wobble = Math.sin(s.wobbleTime * seg.wobbleFreq + seg.wobblePhase + i * 0.8)
                   * CONFIG.wobbleAmplitude * (1 + i * 0.1);

    currentAngle += seg.angleOffset + wobble;

    // If this is the last visible segment and partial, shorten it
    let len = seg.length;
    if (i === visibleSegments - 1 && visibleSegments < s.numSegments) {
      len *= partialFrac || 1;
    }

    x += Math.cos(currentAngle) * len;
    y += Math.sin(currentAngle) * len;
    points.push({ x, y });
  }

  return points;
}

/**
 * Draw a smooth strand through points using quadratic bezier curves
 */
function drawStrand(s) {
  const points = computePoints(s);
  if (points.length < 2) return;

  const { r, g, b } = s.color;
  const alpha = s.alpha;

  // Draw the strand as a tapered, smooth path
  // We'll draw it as a filled shape with varying width
  ctx.save();

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];

    // Thickness tapers from base to tip
    const t0 = s.thickness * (1 - (i / points.length) * 0.7);
    const t1 = s.thickness * (1 - ((i + 1) / points.length) * 0.7);

    // Direction perpendicular to segment
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    // Draw a quadrilateral for each segment
    ctx.beginPath();
    ctx.moveTo(p0.x + nx * t0 / 2, p0.y + ny * t0 / 2);
    ctx.lineTo(p1.x + nx * t1 / 2, p1.y + ny * t1 / 2);
    ctx.lineTo(p1.x - nx * t1 / 2, p1.y - ny * t1 / 2);
    ctx.lineTo(p0.x - nx * t0 / 2, p0.y - ny * t0 / 2);
    ctx.closePath();

    // Gradient alpha along the strand
    const segAlpha = alpha * (1 - (i / points.length) * 0.5);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${segAlpha})`;
    ctx.fill();
  }

  // Draw a smooth overlay using bezier curves for the center line
  // This gives the "core" of the strand a richer look
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
  } else {
    // Smooth curve through points
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];

      if (i === 0) {
        // First segment: quadratic to midpoint
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
      } else if (i === points.length - 2) {
        // Last segment: quadratic to end
        ctx.quadraticCurveTo(points[i].x, points[i].y, p1.x, p1.y);
      } else {
        // Middle segments: quadratic through midpoints
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        ctx.quadraticCurveTo(p0.x, p0.y, midX, midY);
      }
    }
  }

  // Core line (slightly lighter, thinner)
  ctx.strokeStyle = `rgba(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 30)}, ${alpha * 0.6})`;
  ctx.lineWidth = Math.max(1, s.thickness * 0.3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Tip: small circle at the end
  if (points.length >= 2) {
    const tip = points[points.length - 1];
    const tipRadius = s.thickness * 0.2 * (1 - ((points.length - 1) / s.numSegments) * 0.5);
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, Math.max(1, tipRadius), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)}, ${alpha * 0.8})`;
    ctx.fill();
  }

  // Spots along the strand for extra organic feel
  for (let i = 1; i < points.length - 1; i += 2) {
    const p = points[i];
    const spotSize = s.thickness * 0.12 * (1 - (i / points.length) * 0.5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, spotSize), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${Math.max(0, r - 20)}, ${Math.max(0, g - 20)}, ${Math.max(0, b - 20)}, ${alpha * 0.4})`;
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Check if the cursor is near any point of a strand
 */
function isCursorNear(s) {
  const points = computePoints(s);
  for (const p of points) {
    if (dist(mouseX, mouseY, p.x, p.y) < CONFIG.fearRadius) {
      return true;
    }
  }
  return false;
}

/**
 * Update a single strand's state
 */
function updateStrand(s, dt) {
  // Advance wobble time
  s.wobbleTime += CONFIG.wobbleSpeed * (dt / 16);

  // Check for cursor proximity
  const cursorNear = isCursorNear(s);

  if (cursorNear && !s.afraid && s.phase !== 'dead') {
    // FEAR! Rapidly retract
    s.afraid = true;
    s.fearTime = 0;
    s.phase = 'fleeing';
    s.targetExtension = 0;
  }

  // Update phase
  s.phaseTime += dt;

  switch (s.phase) {
    case 'creeping':
      // Slowly extend
      s.extension = clamp(s.extension + CONFIG.creepSpeed * (dt / 1000), 0, 1);
      s.alpha = clamp(s.alpha + 0.01 * (dt / 16), 0, CONFIG.maxAlpha);

      if (s.extension >= 1) {
        s.phase = 'lingering';
        s.phaseTime = 0;
      }
      break;

    case 'lingering':
      // Just wobble in place
      s.alpha = CONFIG.maxAlpha;
      if (s.phaseTime >= s.lingerDuration) {
        s.phase = 'retreating';
        s.phaseTime = 0;
        s.targetExtension = 0;
      }
      break;

    case 'retreating':
      // Slowly retract
      s.extension = clamp(s.extension - CONFIG.retreatSpeed * (dt / 1000), 0, 1);
      s.alpha = clamp(s.extension * CONFIG.maxAlpha, 0, CONFIG.maxAlpha);

      if (s.extension <= 0) {
        s.phase = 'dead';
      }
      break;

    case 'fleeing':
      // Rapidly retract with increased wobble
      s.extension = clamp(s.extension - CONFIG.fleeSpeed * (dt / 1000), 0, 1);
      s.alpha = clamp(s.extension * CONFIG.maxAlpha, 0, CONFIG.maxAlpha);

      // Extra frantic wobble when afraid
      s.wobbleTime += CONFIG.wobbleSpeed * 3 * (dt / 16);

      if (s.extension <= 0) {
        s.phase = 'dead';
      }
      break;
  }
}

/**
 * Main animation loop
 */
function animate(timestamp) {
  const dt = lastTime ? Math.min(timestamp - lastTime, 100) : 16; // cap dt to avoid jumps
  lastTime = timestamp;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Update and draw all strands
  for (const s of strands) {
    updateStrand(s, dt);
    if (s.phase !== 'dead') {
      drawStrand(s);
    }
  }

  // Remove dead strands
  strands = strands.filter(s => s.phase !== 'dead');

  animationId = requestAnimationFrame(animate);
}

/**
 * Spawn a new strand if under the limit
 */
function spawnStrand() {
  if (strands.length < CONFIG.maxStrands) {
    strands.push(createStrand());
  }
  scheduleNextSpawn();
}

/**
 * Schedule the next strand spawn
 */
function scheduleNextSpawn() {
  const delay = rand(CONFIG.spawnIntervalMin, CONFIG.spawnIntervalMax);
  spawnTimer = setTimeout(spawnStrand, delay);
}

/**
 * Resize canvas to fill the window
 */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.scale(dpr, dpr);
}

/**
 * Initialize
 */
function init() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Track mouse position (forwarded even though window is click-through)
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // Also handle mouse leaving the window
  document.addEventListener('mouseleave', () => {
    mouseX = -1000;
    mouseY = -1000;
  });

  // Start animation loop
  animationId = requestAnimationFrame(animate);

  // Spawn a batch immediately from all edges
  for (let i = 0; i < 6; i++) {
    spawnStrand();
  }
  scheduleNextSpawn();
}

init();
