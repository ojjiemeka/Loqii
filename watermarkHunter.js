// watermarkHunter.js
// Multi-stage watermark removal via edge detection + temporal tracking.
//
// Stage 1 — Sobel edge detection on half-res (640×360) frame
// Stage 2 — Candidate scoring: edge density, color variance, aspect ratio
// Stage 3 — Temporal tracking: 2-frame confirmation, jump detection, miss tolerance
// Stage 4 — Adaptive inpainting: 4-border blend + edge feathering
//
// Exports the same public API as watermarkRemover.js so index.html
// only needs an import-line change.

// ─── Constants ───────────────────────────────────────────────────────────────

const BADGE_MIN_WIDTH  = 80;
const BADGE_MAX_WIDTH  = 180;
const BADGE_MIN_HEIGHT = 20;
const BADGE_MAX_HEIGHT = 42;
const BADGE_MIN_ASPECT = 2.5;
const BADGE_MAX_ASPECT = 8.0;
const CONFIRM_FRAMES   = 2;
const MISS_TOLERANCE   = 8;
const JUMP_THRESHOLD   = 120;
const SCORE_THRESHOLD  = 55;
const EDGE_THRESH      = 22;   // Sobel magnitude for an "edge" pixel
const INPAINT_SAMP     = 12;   // px strip sampled on each side for inpainting

// Half-res badge constraints (Sobel runs at 0.5×)
const H_MIN_W = Math.round(BADGE_MIN_WIDTH  * 0.5) - 5;  // 35 — allow corner rounding
const H_MAX_W = Math.round(BADGE_MAX_WIDTH  * 0.5);       // 90
const H_MIN_H = Math.round(BADGE_MIN_HEIGHT * 0.5);       // 10
const H_MAX_H = Math.round(BADGE_MAX_HEIGHT * 0.5);       // 21

// Sobel kernels (row-major 3×3)
const KX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const KY = [-1, -2, -1,  0, 0, 0,  1, 2, 1];

// ─── Module state ────────────────────────────────────────────────────────────

let _proc      = null;   // MediaStreamTrackProcessor
let _gen       = null;   // MediaStreamTrackGenerator
let _canvas    = null;   // OffscreenCanvas — full resolution
let _ctx       = null;
let _hCanvas   = null;   // OffscreenCanvas — half resolution (for Sobel)
let _hCtx      = null;
let _active    = false;
let _pipeCtrl  = null;
let _W         = 1280;
let _H         = 720;
let _frameCount   = 0;
let _avgFrameTime = 0;
let _skipBudget   = false;

// Temporal tracking state
let _confirmedBox   = null;
let _confirmedAt    = 0;
let _candidateBox   = null;
let _candidateCount = 0;
let _missCount      = 0;
let _lastScore      = 0;
let _lastJumpFrame  = 0;
let _lastJumpTime   = 0;
let _positionHistory = [];  // ring buffer (max 4) of recently confirmed centroids
let _candidateSize   = null; // {w,h} of candidate being accumulated

// ─── Public API ──────────────────────────────────────────────────────────────

export async function initWatermarkRemover(rawStream) {
  destroyWatermarkRemover();

  const videoTracks = rawStream.getVideoTracks();
  if (!videoTracks.length) {
    console.warn('[HUNTER] No video track — passing raw stream through');
    return rawStream;
  }
  if (
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined' ||
    typeof VideoFrame                 === 'undefined'
  ) {
    console.warn('[HUNTER] Insertable Streams API unavailable — passing raw stream through');
    return rawStream;
  }

  try {
    const track = videoTracks[0];
    const s     = track.getSettings();
    _W = s.width  || 1280;
    _H = s.height || 720;

    _canvas  = new OffscreenCanvas(_W, _H);
    _ctx     = _canvas.getContext('2d', { willReadFrequently: true });
    _hCanvas = new OffscreenCanvas(_W >> 1, _H >> 1);
    _hCtx    = _hCanvas.getContext('2d', { willReadFrequently: true });

    _proc = new MediaStreamTrackProcessor({ track });
    _gen  = new MediaStreamTrackGenerator({ kind: 'video' });

    const ts = new TransformStream({
      transform(videoFrame, controller) {
        _frameCount++;
        const t0 = performance.now();
        let clean = null;
        try {
          _ctx.drawImage(videoFrame, 0, 0, _W, _H);

          if (!_skipBudget) {
            detectAndTrack();
            if (_confirmedBox) {
              inpaintBox(_confirmedBox);
              if (typeof window !== 'undefined' && window._loqiiWatermarkDebug) {
                drawDebugOverlay();
              }
            }
          }

          const init = { timestamp: videoFrame.timestamp };
          if (videoFrame.duration != null) init.duration = videoFrame.duration;
          clean = new VideoFrame(_canvas, init);

          const ms = performance.now() - t0;
          _skipBudget = ms > 40;
          if (_skipBudget) {
            console.warn(`[HUNTER] Frame budget exceeded ${ms.toFixed(0)}ms — passing through`);
          }
          _avgFrameTime += (ms - _avgFrameTime) / _frameCount;

          videoFrame.close();
          controller.enqueue(clean);
        } catch (err) {
          console.warn('[HUNTER] Frame error:', err.message);
          if (clean) { try { clean.close(); } catch (_) {} }
          try { controller.enqueue(videoFrame); }
          catch (_) { try { videoFrame.close(); } catch (_) {} }
        }
      },
    });

    _pipeCtrl = new AbortController();
    _proc.readable
      .pipeThrough(ts)
      .pipeTo(_gen.writable, { signal: _pipeCtrl.signal })
      .catch(err => {
        if (err?.name !== 'AbortError') console.error('[HUNTER] Pipeline error:', err);
      });

    const clean = new MediaStream([_gen, ...rawStream.getAudioTracks()]);
    _active = true;
    console.log(`[HUNTER] Initialized — ${_W}×${_H}`);
    return clean;
  } catch (err) {
    console.error('[HUNTER] Init failed — raw stream fallback:', err);
    destroyWatermarkRemover();
    return rawStream;
  }
}

export function destroyWatermarkRemover() {
  const was = _active;
  if (_pipeCtrl) { try { _pipeCtrl.abort(); } catch (_) {} _pipeCtrl = null; }
  _proc = _gen = _canvas = _ctx = _hCanvas = _hCtx = null;
  _active = false; _W = 1280; _H = 720;
  _frameCount = 0; _avgFrameTime = 0; _skipBudget = false;
  _confirmedBox = null; _confirmedAt = 0;
  _candidateBox = null; _candidateCount = 0;
  _missCount = 0; _lastScore = 0;
  _lastJumpFrame = 0; _lastJumpTime = 0;
  _positionHistory = []; _candidateSize = null;
  if (was) console.log('[HUNTER] Destroyed');
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }

// ─── Stage 1: Sobel edge detection ───────────────────────────────────────────
//
// Returns a Uint8Array of Sobel gradient magnitudes (0-255) for every pixel.
// Uses integer luminance approximation (77R+150G+29B)>>8 for speed.

function sobelEdges(data, W, H) {
  const edges = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = ((y + ky) * W + (x + kx)) * 4;
          const lum = (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >> 8;
          const ki  = (ky + 1) * 3 + (kx + 1);
          gx += lum * KX[ki];
          gy += lum * KY[ki];
        }
      }
      edges[y * W + x] = Math.min(255, Math.sqrt(gx * gx + gy * gy) | 0);
    }
  }
  return edges;
}

// ─── Stage 1+2: detect best-scored candidate ─────────────────────────────────
//
// 1. Draw frame at half resolution → run Sobel.
// 2. Find per-row horizontal edge runs (80-180px badge = 35-90px at half res).
// 3. Pair top/bottom runs separated by badge height (10-21px at half res).
// 4. Score each pair: edge density + color variance + aspect ratio.
// 5. Return highest-scoring candidate scaled back to full resolution, or null.

function detectCandidate() {
  const HW = _W >> 1, HH = _H >> 1;

  _hCtx.drawImage(_canvas, 0, 0, HW, HH);
  const hImg  = _hCtx.getImageData(0, 0, HW, HH);
  const edges = sobelEdges(hImg.data, HW, HH);

  // Build per-row lists of qualifying edge runs
  const rowRuns = new Array(HH);
  for (let y = 0; y < HH; y++) {
    const runs = [];
    let rs = -1;
    for (let x = 0; x < HW; x++) {
      const hi = edges[y * HW + x] > EDGE_THRESH;
      if (hi && rs < 0) {
        rs = x;
      } else if (!hi && rs >= 0) {
        const rw = x - rs;
        if (rw >= H_MIN_W && rw <= H_MAX_W) runs.push({ x: rs, w: rw });
        rs = -1;
      }
    }
    if (rs >= 0) {
      const rw = HW - rs;
      if (rw >= H_MIN_W && rw <= H_MAX_W) runs.push({ x: rs, w: rw });
    }
    rowRuns[y] = runs;
  }

  // Find top/bottom edge-pair candidates
  let best = null;
  for (let y1 = 1; y1 < HH - H_MIN_H; y1++) {
    if (!rowRuns[y1].length) continue;
    for (const r1 of rowRuns[y1]) {
      for (let dy = H_MIN_H; dy <= H_MAX_H; dy++) {
        const y2 = y1 + dy;
        if (y2 >= HH) break;
        if (!rowRuns[y2].length) continue;
        for (const r2 of rowRuns[y2]) {
          const ox  = Math.max(r1.x, r2.x);
          const ow  = Math.min(r1.x + r1.w, r2.x + r2.w) - ox;
          if (ow < H_MIN_W) continue;

          // Quick aspect pre-filter before variance computation
          const aspect = ow / dy;
          if (aspect < BADGE_MIN_ASPECT || aspect > BADGE_MAX_ASPECT) continue;

          const hbox  = { x: ox, y: y1, w: ow, h: dy };
          const score = scoreCandidate(hbox, hImg.data, edges, HW, HH);
          if (score > SCORE_THRESHOLD && (!best || score > best.score)) {
            // Scale back to full resolution
            best = { x: ox * 2, y: y1 * 2, w: ow * 2, h: dy * 2, score };
          }
        }
      }
    }
  }
  return best;
}

// ─── Stage 2: score a candidate box (0-100) ──────────────────────────────────
//
// edgeScore  (0-40): strong border edges relative to interior → clear badge boundary
// varianceScore (0-30): low internal color variance → uniform badge background
// aspectScore (0-30): aspect ratio close to expected badge proportions

function scoreCandidate(hbox, data, edges, W, H) {
  const { x, y, w, h } = hbox;

  // Aspect score (0-30): centred on aspect ≈ 4
  const aspect     = w / Math.max(h, 1);
  const aDist      = Math.abs(aspect - 4.0) / (BADGE_MAX_ASPECT - BADGE_MIN_ASPECT);
  const aspectScore = Math.max(0, Math.round(30 * (1 - aDist * 1.5)));

  // Color variance score (0-30): badge interior is relatively uniform
  let rS = 0, gS = 0, bS = 0, n = 0;
  for (let fy = y; fy < y + h; fy += 2) {
    for (let fx = x; fx < x + w; fx += 2) {
      const i = (fy * W + fx) * 4;
      rS += data[i]; gS += data[i + 1]; bS += data[i + 2]; n++;
    }
  }
  if (n === 0) return 0;
  const rM = rS / n, gM = gS / n, bM = bS / n;
  let vS = 0;
  for (let fy = y; fy < y + h; fy += 2) {
    for (let fx = x; fx < x + w; fx += 2) {
      const i = (fy * W + fx) * 4;
      vS += (data[i] - rM) ** 2 + (data[i + 1] - gM) ** 2 + (data[i + 2] - bM) ** 2;
    }
  }
  const varianceScore = Math.round(Math.max(0, 30 * (1 - (vS / n) / 250)));

  // Edge score (0-40): top+bottom border rows much stronger than interior rows
  let borderSum = 0, borderN = 0, innerSum = 0, innerN = 0;
  for (let fx = x; fx < x + w; fx++) {
    if (y     > 0) { borderSum += edges[ y      * W + fx]; borderN++; }
    if (y + h < H) { borderSum += edges[(y + h) * W + fx]; borderN++; }
  }
  for (let fy = y + 2; fy < y + h - 2; fy += 2) {
    for (let fx = x; fx < x + w; fx += 2) {
      innerSum += edges[fy * W + fx]; innerN++;
    }
  }
  const borderAvg = borderN > 0 ? borderSum / borderN : 0;
  const innerAvg  = innerN  > 0 ? innerSum  / innerN  : 1;
  const edgeScore = Math.min(40, Math.round((borderAvg / Math.max(innerAvg, 1)) * 15));

  return edgeScore + varianceScore + aspectScore;
}

// ─── Stage 3: temporal tracking ───────────────────────────────────────────────
//
// Called once per frame (except when stably confirmed on even frames).
// Confirms a candidate after CONFIRM_FRAMES=1 detection (immediate).
// Detects jumps > JUMP_THRESHOLD px and confirms new position immediately.
// Clears tracking after MISS_TOLERANCE consecutive missed frames.

function detectAndTrack() {
  // Skip detection on even frames when stably confirmed (halves detection cost)
  const stable    = _confirmedBox !== null && _missCount === 0;
  const recheck   = _confirmedBox !== null && (_frameCount - _confirmedAt) % 90 === 0;
  const evenFrame = (_frameCount & 1) === 0;
  if (stable && evenFrame && !recheck) return;

  const candidate = detectCandidate();

  if (!candidate) {
    _missCount++;
    if (_missCount >= MISS_TOLERANCE && _confirmedBox) {
      console.log(`[HUNTER] Lost tracking after ${_missCount} miss frames`);
      _confirmedBox = null; _candidateBox = null; _candidateCount = 0;
    }
    return;
  }

  _missCount = 0;

  // If confirmed box exists: check for jump or smooth-update
  if (_confirmedBox) {
    const d = centroidDist(_confirmedBox, candidate);
    if (d > JUMP_THRESHOLD) {
      // Oscillation guard: reject if new centroid matches a recently confirmed position
      const isOscillating = _positionHistory.some(prev => {
        const dx = Math.abs(prev.x - candidate.x);
        const dy = Math.abs(prev.y - candidate.y);
        return Math.sqrt(dx * dx + dy * dy) < 20;
      });
      if (isOscillating) {
        console.log('[HUNTER] Oscillation suppressed at', candidate.x, candidate.y);
        return; // keep current _confirmedBox
      }

      const now            = performance.now();
      const intervalMs     = _lastJumpTime > 0 ? Math.round(now - _lastJumpTime) : 0;
      const intervalFrames = _frameCount - _lastJumpFrame;
      _lastJumpTime  = now;
      _lastJumpFrame = _frameCount;
      console.log(
        '[HUNTER] Jump detected:',
        `(${(_confirmedBox.x + _confirmedBox.w / 2) | 0},` +
        `${(_confirmedBox.y + _confirmedBox.h / 2) | 0})`,
        '→',
        `(${(candidate.x + candidate.w / 2) | 0},` +
        `${(candidate.y + candidate.h / 2) | 0})`,
        `distance=${Math.round(d)}px`
      );
      if (intervalMs > 0) {
        console.log(`[HUNTER] Jump interval: ${intervalMs}ms (${intervalFrames} frames since last jump)`);
      }
      // Add to history and confirm new position immediately
      _positionHistory.push({ x: candidate.x, y: candidate.y });
      if (_positionHistory.length > 4) _positionHistory.shift();
      _confirmedBox   = { ...candidate };
      _confirmedAt    = _frameCount;
      _candidateBox   = null;
      _candidateCount = 0;
      _candidateSize  = null;
      return;
    }
    // Smooth-update confirmed position with low momentum (prevents drift)
    _confirmedBox = smoothBox(_confirmedBox, candidate, 0.15);
    _lastScore    = candidate.score;
    return;
  }

  // Accumulate candidate frames until CONFIRM_FRAMES reached
  if (_candidateBox && centroidDist(_candidateBox, candidate) <= 8) {
    // Stability check: consistent size across confirmation frames
    if (_candidateSize) {
      const dw = Math.abs(candidate.w - _candidateSize.w);
      const dh = Math.abs(candidate.h - _candidateSize.h);
      if (dw > 15 || dh > 15) {
        _candidateBox   = null;
        _candidateCount = 0;
        _candidateSize  = null;
        return;
      }
    }
    _candidateSize = { w: candidate.w, h: candidate.h };
    _candidateCount++;
    _candidateBox = smoothBox(_candidateBox, candidate, 0.5);
    _lastScore    = candidate.score;

    if (_candidateCount >= CONFIRM_FRAMES) {
      // Oscillation guard: reject if position matches recent confirmed history
      const isOscillating = _positionHistory.some(prev => {
        const dx = Math.abs(prev.x - _candidateBox.x);
        const dy = Math.abs(prev.y - _candidateBox.y);
        return Math.sqrt(dx * dx + dy * dy) < 20;
      });
      if (isOscillating && _confirmedBox) {
        console.log('[HUNTER] Oscillation suppressed at', _candidateBox.x, _candidateBox.y);
        _candidateBox   = null;
        _candidateCount = 0;
        _candidateSize  = null;
        return;
      }
      _positionHistory.push({ x: _candidateBox.x, y: _candidateBox.y });
      if (_positionHistory.length > 4) _positionHistory.shift();
      _confirmedBox = { ..._candidateBox };
      _confirmedAt  = _frameCount;
      console.log(
        `[HUNTER] Confirmed at (${_confirmedBox.x},${_confirmedBox.y}` +
        ` ${_confirmedBox.w}×${_confirmedBox.h})` +
        ` after ${_candidateCount} frames — score=${_lastScore}`
      );
    }
  } else {
    _candidateBox   = candidate;
    _candidateCount = 1;
    _candidateSize  = null;
  }
}

function centroidDist(a, b) {
  const ax = a.x + a.w * 0.5, ay = a.y + a.h * 0.5;
  const bx = b.x + b.w * 0.5, by = b.y + b.h * 0.5;
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

function smoothBox(prev, next, alpha) {
  return {
    x: Math.round(prev.x * (1 - alpha) + next.x * alpha),
    y: Math.round(prev.y * (1 - alpha) + next.y * alpha),
    w: Math.round(prev.w * (1 - alpha) + next.w * alpha),
    h: Math.round(prev.h * (1 - alpha) + next.h * alpha),
  };
}

// ─── Stage 4: adaptive inpainting ────────────────────────────────────────────
//
// Samples 12-pixel strips above, below, left, and right of the confirmed box.
// Each strip is averaged to a single reference row/column.
// Fill pixels are bilinear-interpolated from all available references.
// A 2-pixel feather at the fill border blends toward original pixels.

function inpaintBox(box) {
  const { x, y, w, h } = box;
  const SAMP = INPAINT_SAMP;

  const rx = Math.max(0, x), ry = Math.max(0, y);
  const rw = Math.min(_W - rx, w), rh = Math.min(_H - ry, h);
  if (rw <= 0 || rh <= 0) return;

  const aboveY  = ry - SAMP, hasAbove = aboveY >= 0;
  const belowY  = ry + rh,   hasBelow = belowY + SAMP <= _H;
  const leftX   = rx - SAMP, hasLeft  = leftX  >= 0;
  const rightX  = rx + rw,   hasRight = rightX + SAMP <= _W;

  // Column-averaged reference (for above/below strips)
  function colAvg(d, cols, rows) {
    const o = new Float32Array(cols * 3);
    for (let c = 0; c < cols; c++) {
      let r = 0, g = 0, b = 0;
      for (let row = 0; row < rows; row++) {
        const i = (row * cols + c) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2];
      }
      o[c * 3] = r / rows; o[c * 3 + 1] = g / rows; o[c * 3 + 2] = b / rows;
    }
    return o;
  }

  // Row-averaged reference (for left/right strips)
  function rowAvg(d, cols, rows) {
    const o = new Float32Array(rows * 3);
    for (let r = 0; r < rows; r++) {
      let rv = 0, gv = 0, bv = 0;
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        rv += d[i]; gv += d[i + 1]; bv += d[i + 2];
      }
      o[r * 3] = rv / cols; o[r * 3 + 1] = gv / cols; o[r * 3 + 2] = bv / cols;
    }
    return o;
  }

  const above = hasAbove ? colAvg(_ctx.getImageData(rx, aboveY, rw, SAMP).data, rw, SAMP) : null;
  const below = hasBelow ? colAvg(_ctx.getImageData(rx, belowY, rw, SAMP).data, rw, SAMP) : null;
  const left  = hasLeft  ? rowAvg(_ctx.getImageData(leftX,  ry, SAMP, rh).data, SAMP, rh) : null;
  const right = hasRight ? rowAvg(_ctx.getImageData(rightX, ry, SAMP, rh).data, SAMP, rh) : null;

  if (!above && !below && !left && !right) return;

  // Original pixels for border feathering
  const orig = _ctx.getImageData(rx, ry, rw, rh).data;
  const fill = _ctx.createImageData(rw, rh);

  for (let fy = 0; fy < rh; fy++) {
    const t = rh > 1 ? fy / (rh - 1) : 0.5;   // 0=top → 1=bottom

    for (let fx = 0; fx < rw; fx++) {
      const s  = rw > 1 ? fx / (rw - 1) : 0.5;  // 0=left → 1=right
      const fi = (fy * rw + fx) * 4;
      const ci = fx * 3;
      const ri = fy * 3;

      // Top-bottom blend
      let tbR = 0, tbG = 0, tbB = 0, tbW = 0;
      if (above && below) {
        tbR = above[ci] * (1 - t) + below[ci] * t;
        tbG = above[ci + 1] * (1 - t) + below[ci + 1] * t;
        tbB = above[ci + 2] * (1 - t) + below[ci + 2] * t;
        tbW = 1;
      } else if (above) { tbR = above[ci]; tbG = above[ci + 1]; tbB = above[ci + 2]; tbW = 1; }
      else if (below)   { tbR = below[ci]; tbG = below[ci + 1]; tbB = below[ci + 2]; tbW = 1; }

      // Left-right blend
      let lrR = 0, lrG = 0, lrB = 0, lrW = 0;
      if (left && right) {
        lrR = left[ri] * (1 - s) + right[ri] * s;
        lrG = left[ri + 1] * (1 - s) + right[ri + 1] * s;
        lrB = left[ri + 2] * (1 - s) + right[ri + 2] * s;
        lrW = 1;
      } else if (left)  { lrR = left[ri];  lrG = left[ri + 1];  lrB = left[ri + 2];  lrW = 1; }
      else if (right)   { lrR = right[ri]; lrG = right[ri + 1]; lrB = right[ri + 2]; lrW = 1; }

      // Combine top-bottom and left-right
      const tw = tbW + lrW || 1;
      let fR = (tbR * tbW + lrR * lrW) / tw;
      let fG = (tbG * tbW + lrG * lrW) / tw;
      let fB = (tbB * tbW + lrB * lrW) / tw;

      // 2-pixel edge feather: blend fill toward original at border
      const bd = Math.min(fx, fy, rw - 1 - fx, rh - 1 - fy);
      if (bd < 2) {
        const op = 0.6 + bd * 0.2;  // bd=0 → 0.60, bd=1 → 0.80, bd≥2 → 1.0
        fR = fR * op + orig[fi]     * (1 - op);
        fG = fG * op + orig[fi + 1] * (1 - op);
        fB = fB * op + orig[fi + 2] * (1 - op);
      }

      fill.data[fi]     = (fR + 0.5) | 0;
      fill.data[fi + 1] = (fG + 0.5) | 0;
      fill.data[fi + 2] = (fB + 0.5) | 0;
      fill.data[fi + 3] = 255;
    }
  }

  _ctx.putImageData(fill, rx, ry);
}

// ─── Debug overlay ────────────────────────────────────────────────────────────
//
// Activated by: window._loqiiWatermarkDebug = true
// Red  = confirmed box, Yellow = candidate box, green HUD = stats

function drawDebugOverlay() {
  _ctx.save();

  if (_confirmedBox) {
    _ctx.strokeStyle = 'rgba(255,0,0,0.9)';
    _ctx.lineWidth   = 2;
    _ctx.strokeRect(_confirmedBox.x, _confirmedBox.y, _confirmedBox.w, _confirmedBox.h);
  }
  if (_candidateBox) {
    _ctx.strokeStyle = 'rgba(255,255,0,0.7)';
    _ctx.lineWidth   = 1;
    _ctx.strokeRect(_candidateBox.x, _candidateBox.y, _candidateBox.w, _candidateBox.h);
  }

  const cx = _confirmedBox
    ? `(${_confirmedBox.x},${_confirmedBox.y})`
    : 'none';
  _ctx.fillStyle = 'rgba(0,0,0,0.65)';
  _ctx.fillRect(4, 4, 420, 22);
  _ctx.fillStyle = '#00ff88';
  _ctx.font      = '12px monospace';
  _ctx.fillText(
    `HUNTER: confirmed=${cx}  score=${_lastScore}  avgMs=${_avgFrameTime.toFixed(1)}`,
    8, 19
  );

  _ctx.restore();
}
