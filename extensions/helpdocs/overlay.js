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
  spawnIntervalMin: 800,     // faster spawning
  spawnIntervalMax: 2500,

  // Strand properties
  minSegments: 8,
  maxSegments: 18,
  minSegmentLength: 14,
  maxSegmentLength: 30,
  minThickness: 8,
  maxThickness: 22,

  // Animation
  creepSpeed: 0.8,           // pixels per frame when creeping in
  retreatSpeed: 0.15,        // pixels per frame when retreating naturally
  fleeSpeed: 3.0,            // pixels per frame when fleeing from cursor
  wobbleSpeed: 0.015,        // base radians per frame for wobble
  wobbleAmplitude: 0.08,     // base wobble at root (increases toward tip)
  tipAmplitude: 0.35,        // max wobble at tip
  curlStrength: 0.4,         // tendency to curl (0 = straight, 1 = tight spiral)
  curlDriftSpeed: 0.003,     // how fast the curl direction changes

  // Lifecycle
  creepInDuration: 3000,     // ms to creep in
  lingerDurationMin: 4000,   // ms to linger at max extension
  lingerDurationMax: 10000,  // ms to linger at max extension
  retreatDuration: 4000,     // ms to retreat

  // Fear response
  fearRadius: 100,           // px distance to trigger fear
  fearRecoveryTime: 2000,    // ms before strand can return after fear

  // Visual
  maxAlpha: 1.0,
  colors: [
    { r: 60, g: 30, b: 90 },    // deep purple
    { r: 30, g: 65, b: 55 },    // dark teal
    { r: 40, g: 40, b: 75 },    // deep slate blue
    { r: 55, g: 30, b: 65 },    // dark violet
    { r: 25, g: 55, b: 45 },    // deep sea green
    { r: 45, g: 25, b: 50 },    // near-black plum
  ],

  // Max simultaneous strands
  maxStrands: 30,
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
 * Create a new strand emerging from a specific or random edge.
 * @param {number} [forceEdge] - If provided, use this edge (0-3). Otherwise random.
 */
function createStrand(forceEdge) {
  const edge = forceEdge !== undefined ? forceEdge : randInt(0, 3);
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

  // Each segment has a base angle offset and independent wobble parameters
  const segments = [];
  for (let i = 0; i < numSegments; i++) {
    segments.push({
      length: segmentLength * (1 - i * 0.03), // taper slightly
      angleOffset: rand(-0.1, 0.1),           // slight random curvature
      wobblePhase: rand(0, Math.PI * 2),       // random initial phase
      wobbleFreq: rand(0.5, 1.5),             // varied wobble frequency
      // Secondary slower wobble for more complex motion
      wobblePhase2: rand(0, Math.PI * 2),
      wobbleFreq2: rand(0.15, 0.4),           // much slower secondary wave
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

    // Curl state: a slow-drifting bias that makes segments curl in one direction
    curlBias: rand(-1, 1),           // current curl direction (-1 to 1)
    curlPhase: rand(0, Math.PI * 2), // phase for curl drift

    // Alpha
    alpha: 0,
  };
}

/**
 * Compute the joint positions of a strand
 * Returns array of {x, y} points from base to tip
 *
 * Motion model:
 * - Base segments are relatively stable (anchored to the edge)
 * - Tip segments are much more active and mobile
 * - A slow-drifting curl bias makes the whole strand curl/uncurl over time
 * - Two wobble frequencies per segment create complex, non-repetitive motion
 * - Curl accumulates along the strand (each segment adds to the curve)
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

    // How far along the strand (0 = base, 1 = tip)
    const t = i / s.numSegments;

    // Wobble amplitude increases toward tip (tentacle-like: base stable, tip active)
    const amplitude = lerp(CONFIG.wobbleAmplitude, CONFIG.tipAmplitude, t * t);

    // Primary wobble: faster, smaller oscillation
    const wobble1 = Math.sin(s.wobbleTime * seg.wobbleFreq + seg.wobblePhase + i * 0.6)
                    * amplitude;

    // Secondary wobble: slower, creates longer sweeping motions
    const wobble2 = Math.sin(s.wobbleTime * seg.wobbleFreq2 + seg.wobblePhase2 + i * 0.3)
                    * amplitude * 0.7;

    // Curl: accumulates along the strand, creating spiral/curl shapes
    // The curl bias drifts slowly so the strand curls and uncurls over time
    const curl = s.curlBias * CONFIG.curlStrength * t;

    currentAngle += seg.angleOffset + wobble1 + wobble2 + curl;

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

    // Thickness tapers from base to tip — gradual taper, base stays thick
    const t0 = s.thickness * (1 - (i / points.length) * 0.5);
    const t1 = s.thickness * (1 - ((i + 1) / points.length) * 0.5);

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

    // Solid color — no per-segment alpha fade
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

  // Drift the curl bias — slow sinusoidal drift creates curling/uncurling over time
  s.curlPhase += CONFIG.curlDriftSpeed * (dt / 16);
  s.curlBias = Math.sin(s.curlPhase) * 0.8 + Math.sin(s.curlPhase * 0.37) * 0.2;

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
      s.alpha = clamp(s.alpha + 0.03 * (dt / 16), 0, CONFIG.maxAlpha);

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
 * Edge rotation for spawning — cycles through edges to ensure strands
 * come from at least 3 sides. Uses a shuffled queue that refills when empty.
 */
let edgeQueue = [];

function nextEdge() {
  if (edgeQueue.length === 0) {
    // Refill with all 4 edges, shuffled
    edgeQueue = [0, 1, 2, 3];
    for (let i = edgeQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [edgeQueue[i], edgeQueue[j]] = [edgeQueue[j], edgeQueue[i]];
    }
  }
  return edgeQueue.pop();
}

/**
 * Spawn a new strand if under the limit
 */
function spawnStrand() {
  if (strands.length < CONFIG.maxStrands) {
    strands.push(createStrand(nextEdge()));
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

  // Spawn initial batch — guarantee at least one strand per edge,
  // plus 2 extra from random edges, for immediate multi-side presence.
  const initialEdges = [0, 1, 2, 3];
  // Shuffle so the order isn't predictable
  for (let i = initialEdges.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [initialEdges[i], initialEdges[j]] = [initialEdges[j], initialEdges[i]];
  }
  for (const edge of initialEdges) {
    strands.push(createStrand(edge));
  }
  // Plus 6 extra from the rotating queue for a full initial presence
  for (let i = 0; i < 6; i++) {
    strands.push(createStrand(nextEdge()));
  }
  scheduleNextSpawn();
}

init();
