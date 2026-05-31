'use strict';

// watermarkSharp.js — main-process watermark removal via Sharp + libvips
//
// Called once per video frame via IPC ('watermark:process').
// Receives raw 1280×720 RGBA buffer from renderer, returns clean buffer.
//
// Detection: grid scan comparing internal brightness vs surrounding border.
// Inpainting: column-averaged reference strips blended vertically via Sharp composite.
//
// Tuning constants:
//   SCORE_THRESH  0.15 = watermark must be 15% brighter than surroundings
//                 Lower → more sensitive (may false-positive)
//                 Raise → stricter (may miss dim watermark)
//   SCAN_STEP     outer grid step in px — raise to skip more positions (faster)

const sharp = require('sharp');

// ─── Frame constants ─────────────────────────────────────────────────────────

const FRAME_WIDTH  = 1280;
const FRAME_HEIGHT = 720;
const CHANNELS     = 4;    // RGBA

// ─── Detection parameters ────────────────────────────────────────────────────

const SCORE_THRESH = 0.15; // min inside/outside brightness ratio
const SCAN_STEP    = 16;   // outer grid step — balanced speed vs coverage
const BORDER_PX    = 12;   // surrounding strip sampled for outside average
const SAMP_PX      = 3;    // pixel stride inside scoring loops

// Badge size candidates tried at every scan position
const BADGE_SIZES = [
  { w:  80, h: 18 },
  { w:  90, h: 22 },
  { w: 100, h: 24 },
  { w: 120, h: 26 },
];

// ─── Inpainting parameters ────────────────────────────────────────────────────

const STRIP_H  = 16; // height of reference strip sampled above and below fill
const FILL_PAD = 6;  // px added around detected region before painting

// ─── Public API ───────────────────────────────────────────────────────────────

async function processFrame(rgbaBuffer) {
  try {
    const region = detectBadgeRegion(rgbaBuffer);
    if (!region) return rgbaBuffer;
    return await inpaintRegion(rgbaBuffer, region);
  } catch (err) {
    console.error('[SHARP] processFrame error:', err.message);
    return rgbaBuffer;
  }
}

module.exports = { processFrame };

// ─── Detection ───────────────────────────────────────────────────────────────
//
// Fast pre-check: sample the frame at coarse intervals; if no pixel is
// ≥30% above the average, skip the full scan (no visible watermark).
//
// Main scan: try each badge-size candidate at every SCAN_STEP grid position.
// scoreBadgeAt compares average luminance inside the candidate box vs the
// 12px border strip above and below. Returns the best-scoring region.

function detectBadgeRegion(rgbaBuffer) {
  const data = rgbaBuffer;

  // Fast pre-check: sample every 40px, find mean + max brightness
  let brightSum = 0, brightMax = 0, sampleN = 0;
  for (let y = 0; y < FRAME_HEIGHT; y += 40) {
    for (let x = 0; x < FRAME_WIDTH; x += 40) {
      const i = (y * FRAME_WIDTH + x) * CHANNELS;
      const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      brightSum += lum;
      if (lum > brightMax) brightMax = lum;
      sampleN++;
    }
  }
  const avgBrightness = brightSum / sampleN;
  if (brightMax < avgBrightness * 1.30) return null; // nothing unusually bright

  let bestScore  = SCORE_THRESH;
  let bestRegion = null;

  for (let y = 5; y < FRAME_HEIGHT - 45; y += SCAN_STEP) {
    for (let x = 5; x < FRAME_WIDTH - 125; x += SCAN_STEP) {
      for (const { w: bw, h: bh } of BADGE_SIZES) {
        const score = scoreBadgeAt(data, x, y, bw, bh);
        if (score > bestScore) {
          bestScore  = score;
          bestRegion = { x, y, w: bw, h: bh, score };
        }
      }
    }
  }

  if (bestRegion) {
    console.log(
      '[SHARP] Badge at', bestRegion.x, bestRegion.y,
      `${bestRegion.w}×${bestRegion.h}`,
      'score:', bestRegion.score.toFixed(3)
    );
  }
  return bestRegion;
}

function scoreBadgeAt(data, x, y, bw, bh) {
  // Reject wrong aspect ratio before touching pixel data
  const aspect = bw / bh;
  if (aspect < 2.0 || aspect > 9.0) return 0;

  let insideSum = 0, insideN = 0;
  let outsideSum = 0, outsideN = 0;

  // Sample inside the candidate box
  for (let dy = 0; dy < bh; dy += SAMP_PX) {
    for (let dx = 0; dx < bw; dx += SAMP_PX) {
      const i = ((y + dy) * FRAME_WIDTH + (x + dx)) * CHANNELS;
      insideSum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      insideN++;
    }
  }

  // Sample strip above
  for (let dy = -BORDER_PX; dy < 0; dy += SAMP_PX) {
    if (y + dy < 0) continue;
    for (let dx = 0; dx < bw; dx += SAMP_PX) {
      const i = ((y + dy) * FRAME_WIDTH + (x + dx)) * CHANNELS;
      outsideSum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      outsideN++;
    }
  }

  // Sample strip below
  for (let dy = bh; dy < bh + BORDER_PX; dy += SAMP_PX) {
    if (y + dy >= FRAME_HEIGHT) continue;
    for (let dx = 0; dx < bw; dx += SAMP_PX) {
      const i = ((y + dy) * FRAME_WIDTH + (x + dx)) * CHANNELS;
      outsideSum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      outsideN++;
    }
  }

  if (insideN === 0 || outsideN === 0) return 0;
  const insideAvg  = insideSum  / insideN;
  const outsideAvg = outsideSum / outsideN;
  if (outsideAvg === 0) return 0;

  // Normalised delta: how much brighter inside is vs outside
  return Math.max(0, (insideAvg - outsideAvg) / outsideAvg);
}

// ─── Inpainting ───────────────────────────────────────────────────────────────
//
// Extract 16px reference strips above and below the padded fill region.
// Column-average each strip into a single reference row.
// Build a fill patch by interpolating between top and bottom references.
// Composite the patch onto the full frame via Sharp.

async function inpaintRegion(rgbaBuffer, region) {
  const { x, y, w, h } = region;

  const rx = Math.max(0, x - FILL_PAD);
  const ry = Math.max(0, y - FILL_PAD);
  const rw = Math.min(FRAME_WIDTH  - rx, w + FILL_PAD * 2);
  const rh = Math.min(FRAME_HEIGHT - ry, h + FILL_PAD * 2);

  const topY = Math.max(0, ry - STRIP_H);
  const botY = Math.min(FRAME_HEIGHT - STRIP_H, ry + rh);

  const rawOpts = { raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: CHANNELS } };

  // Extract reference strips
  const [topRaw, botRaw] = await Promise.all([
    sharp(rgbaBuffer, rawOpts)
      .extract({ left: rx, top: topY, width: rw, height: STRIP_H })
      .raw().toBuffer(),
    sharp(rgbaBuffer, rawOpts)
      .extract({ left: rx, top: botY, width: rw, height: STRIP_H })
      .raw().toBuffer(),
  ]);

  // Column-average each strip into one reference row
  const topRef = new Uint8Array(rw * CHANNELS);
  const botRef = new Uint8Array(rw * CHANNELS);
  for (let col = 0; col < rw; col++) {
    let tr = 0, tg = 0, tb = 0, br = 0, bg = 0, bb = 0;
    for (let row = 0; row < STRIP_H; row++) {
      const si = (row * rw + col) * CHANNELS;
      tr += topRaw[si];     tg += topRaw[si + 1]; tb += topRaw[si + 2];
      br += botRaw[si];     bg += botRaw[si + 1]; bb += botRaw[si + 2];
    }
    const tc = col * CHANNELS;
    topRef[tc] = (tr / STRIP_H) | 0; topRef[tc + 1] = (tg / STRIP_H) | 0;
    topRef[tc + 2] = (tb / STRIP_H) | 0; topRef[tc + 3] = 255;
    botRef[tc] = (br / STRIP_H) | 0; botRef[tc + 1] = (bg / STRIP_H) | 0;
    botRef[tc + 2] = (bb / STRIP_H) | 0; botRef[tc + 3] = 255;
  }

  // Build fill patch via vertical interpolation
  const fillBuf = Buffer.alloc(rw * rh * CHANNELS);
  for (let row = 0; row < rh; row++) {
    const t = rh > 1 ? row / (rh - 1) : 0.5;
    for (let col = 0; col < rw; col++) {
      const fi = (row * rw + col) * CHANNELS;
      const ci = col * CHANNELS;
      fillBuf[fi]     = (topRef[ci]     * (1 - t) + botRef[ci]     * t + 0.5) | 0;
      fillBuf[fi + 1] = (topRef[ci + 1] * (1 - t) + botRef[ci + 1] * t + 0.5) | 0;
      fillBuf[fi + 2] = (topRef[ci + 2] * (1 - t) + botRef[ci + 2] * t + 0.5) | 0;
      fillBuf[fi + 3] = 255;
    }
  }

  // Composite fill over the full frame and return raw RGBA buffer
  return sharp(rgbaBuffer, rawOpts)
    .composite([{
      input: fillBuf,
      raw: { width: rw, height: rh, channels: CHANNELS },
      left: rx,
      top: ry,
      blend: 'over',
    }])
    .raw()
    .toBuffer();
}
