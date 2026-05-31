// watermarkHunter.js
// Two-phase watermark removal via template matching.
//
// Phase 1 — Auto-capture (first 60 frames)
//   Fast brightness scan on a 64×36 downsampled canvas accumulates a heat map.
//   The most consistent bright cluster matching badge dimensions is captured as
//   a template (ImageData snapshot of that region in the live frame).
//
// Phase 2 — Template search (every frame after capture)
//   4×4 grid MAD search finds the badge anywhere in the frame.
//   A ±50px window search around the last confirmed position handles stable tracking
//   and is 10× cheaper than the full grid search (used first each frame).
//   Jump detection at 150px centroid distance updates the confirmed box immediately.
//
// Stage 4 — Adaptive inpainting (unchanged from edge-detection version)
//   4-border bilinear blend + 2-pixel edge feather.
//
// Exports identical public API to watermarkRemover.js.

// ─── Constants ───────────────────────────────────────────────────────────────

const CAPTURE_FRAMES         = 60;
const CAPTURE_SCAN_STRIDE    = 20;   // tiny canvas cell size in source pixels
const CAPTURE_BRIGHT_THRESH  = 180;
const CAPTURE_MIN_FRAMES     = 20;   // hot cell threshold — appear in 20/60 frames
const TEMPLATE_MAD_THRESHOLD = 30;   // confirmed match for window search
const TEMPLATE_MAD_POSSIBLE  = 50;   // accepted match for full grid search
const JUMP_THRESHOLD         = 150;
const MISS_TOLERANCE         = 10;
const SEARCH_STEP            = 3;    // pixel stride inside MAD comparisons
const GRID_DIVISIONS         = 4;    // 4×4 = 16 grid search points
const INPAINT_SAMP           = 12;

// ─── Module state ────────────────────────────────────────────────────────────

// Template (Phase 1)
let _template         = null;   // Uint8ClampedArray (RGBA) of captured region
let _templateBox      = null;   // {x,y,w,h} — full-res coords of template
let _templateCaptured = false;
let _captureHeatmap   = null;   // Uint16Array, _GW×_GH cells
let _captureCount     = 0;      // frames processed in current capture window
let _captureSkip      = 0;      // frames to idle before next capture attempt

// Tracking (Phase 2)
let _confirmedBox  = null;
let _lastSearchBox = null;
let _missCount     = 0;
let _lastMAD       = 0;

// Pipeline
let _proc      = null;
let _gen       = null;
let _canvas    = null;   // full-res OffscreenCanvas (drawn + inpainted)
let _ctx       = null;
let _tinyCanvas = null;  // 64×36 for capture-phase brightness scan
let _tinyCtx   = null;
let _active    = false;
let _pipeCtrl  = null;
let _W         = 1280;
let _H         = 720;
let _GW        = 64;    // ceil(_W / CAPTURE_SCAN_STRIDE)
let _GH        = 36;    // ceil(_H / CAPTURE_SCAN_STRIDE)
let _frameCount   = 0;
let _avgFrameTime = 0;
let _skipBudget   = false;

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
    _GW = Math.ceil(_W / CAPTURE_SCAN_STRIDE);
    _GH = Math.ceil(_H / CAPTURE_SCAN_STRIDE);

    _canvas    = new OffscreenCanvas(_W, _H);
    _ctx       = _canvas.getContext('2d', { willReadFrequently: true });
    _tinyCanvas = new OffscreenCanvas(_GW, _GH);
    _tinyCtx   = _tinyCanvas.getContext('2d', { willReadFrequently: true });

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
            if (!_templateCaptured) {
              doCaptureTick();
            } else {
              doTrackTick();
              if (_confirmedBox) inpaintBox(_confirmedBox);
            }
            if (typeof window !== 'undefined' && window._loqiiWatermarkDebug) {
              drawDebugOverlay();
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
    console.log(`[HUNTER] Initialized — ${_W}×${_H}, capture phase starting`);
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
  _proc = _gen = _canvas = _ctx = _tinyCanvas = _tinyCtx = null;
  _active = false; _W = 1280; _H = 720; _GW = 64; _GH = 36;
  _frameCount = 0; _avgFrameTime = 0; _skipBudget = false;
  _template = null; _templateBox = null; _templateCaptured = false;
  _captureHeatmap = null; _captureCount = 0; _captureSkip = 0;
  _confirmedBox = null; _lastSearchBox = null;
  _missCount = 0; _lastMAD = 0;
  if (was) console.log('[HUNTER] Destroyed');
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }

// ─── Phase 1: auto-capture template ──────────────────────────────────────────
//
// For CAPTURE_FRAMES frames, downscale the current frame to a _GW×_GH (64×36)
// canvas using drawImage, then count bright cells (R/G/B all > 180) into a
// heat map. After 60 frames, the hottest connected cluster with badge proportions
// becomes the template — its region is captured from the full-res canvas as
// the reference for Phase 2 MAD matching.

function doCaptureTick() {
  // Idle period after a failed capture attempt
  if (_captureSkip > 0) {
    _captureSkip--;
    return;
  }

  // Lazy-init heat map
  if (!_captureHeatmap) {
    _captureHeatmap = new Uint16Array(_GW * _GH);
  }

  // Downsample to tiny canvas and read brightness
  _tinyCtx.drawImage(_canvas, 0, 0, _GW, _GH);
  const tiny = _tinyCtx.getImageData(0, 0, _GW, _GH).data;

  for (let gy = 0; gy < _GH; gy++) {
    for (let gx = 0; gx < _GW; gx++) {
      const i = (gy * _GW + gx) * 4;
      if (
        tiny[i]     > CAPTURE_BRIGHT_THRESH &&
        tiny[i + 1] > CAPTURE_BRIGHT_THRESH &&
        tiny[i + 2] > CAPTURE_BRIGHT_THRESH
      ) {
        _captureHeatmap[gy * _GW + gx]++;
      }
    }
  }

  _captureCount++;

  if (_captureCount >= CAPTURE_FRAMES) {
    finishCapture();
  }
}

function finishCapture() {
  const bounds = findTemplateBounds();

  if (!bounds) {
    console.log('[HUNTER] Template capture failed — watermark not detected in first 60 frames. Retrying...');
    _captureCount = 0;
    _captureHeatmap.fill(0);
    _captureSkip = CAPTURE_FRAMES; // idle for 60 more frames before retry
    return;
  }

  // Expand detected cluster by 4px padding
  const px = Math.max(0, bounds.x - 4);
  const py = Math.max(0, bounds.y - 4);
  const pw = Math.min(_W - px, bounds.w + 8);
  const ph = Math.min(_H - py, bounds.h + 8);

  _template    = _ctx.getImageData(px, py, pw, ph).data;
  _templateBox = { x: px, y: py, w: pw, h: ph };
  _templateCaptured = true;

  console.log(`[HUNTER] Template captured at (${px},${py},${pw}×${ph})`);
}

function findTemplateBounds() {
  const HOT     = CAPTURE_MIN_FRAMES;
  const visited = new Uint8Array(_GW * _GH);
  let best = null;

  for (let gy = 0; gy < _GH; gy++) {
    for (let gx = 0; gx < _GW; gx++) {
      const idx0 = gy * _GW + gx;
      if (visited[idx0] || _captureHeatmap[idx0] < HOT) continue;

      // BFS flood-fill over connected hot cells
      const queue  = [idx0];
      visited[idx0] = 1;
      let minGX = gx, maxGX = gx, minGY = gy, maxGY = gy;
      let totalHeat = 0;
      let qi = 0;

      while (qi < queue.length) {
        const idx = queue[qi++];
        const cy  = (idx / _GW) | 0;
        const cx  = idx  % _GW;
        totalHeat += _captureHeatmap[idx];

        // 4-connected neighbours
        const ns = [
          cy > 0     ? (cy - 1) * _GW + cx : -1,
          cy < _GH-1 ? (cy + 1) * _GW + cx : -1,
          cx > 0     ? cy       * _GW + (cx - 1) : -1,
          cx < _GW-1 ? cy       * _GW + (cx + 1) : -1,
        ];
        for (const ni of ns) {
          if (ni < 0 || visited[ni] || _captureHeatmap[ni] < HOT) continue;
          visited[ni] = 1;
          queue.push(ni);
          const ny = (ni / _GW) | 0, nx = ni % _GW;
          if (nx < minGX) minGX = nx;
          if (nx > maxGX) maxGX = nx;
          if (ny < minGY) minGY = ny;
          if (ny > maxGY) maxGY = ny;
        }
      }

      // Convert grid → pixel coords
      const px = minGX * CAPTURE_SCAN_STRIDE;
      const py = minGY * CAPTURE_SCAN_STRIDE;
      const pw = (maxGX - minGX + 1) * CAPTURE_SCAN_STRIDE;
      const ph = (maxGY - minGY + 1) * CAPTURE_SCAN_STRIDE;

      // Validate badge dimensions: 60-200px wide, 15-45px tall
      if (pw >= 60 && pw <= 200 && ph >= 15 && ph <= 45) {
        if (!best || totalHeat > best.heat) {
          best = { x: px, y: py, w: pw, h: ph, heat: totalHeat };
        }
      }
    }
  }

  return best;
}

// ─── Phase 2: template search ─────────────────────────────────────────────────
//
// Each tracking frame:
//   1. Window search — 5×5 sub-grid ±50px around last confirmed position.
//      Uses a partial getImageData (cheap, ~0.1ms). Threshold: MAD ≤ 30.
//   2. Full grid search — 4×4 grid covering the whole frame + 5×5 refinement.
//      Uses full-frame getImageData (~3ms). Threshold: MAD ≤ 50.
// Jump at >150px centroid distance updates _confirmedBox immediately.
// After MISS_TOLERANCE consecutive misses, tracking is cleared.

function doTrackTick() {
  const { w: tw, h: th } = _templateBox;
  let found = null;

  // --- Window search (fast path, common case) ---
  if (_lastSearchBox) {
    const RANGE = 50;
    const wx  = Math.max(0, _lastSearchBox.x - RANGE);
    const wy  = Math.max(0, _lastSearchBox.y - RANGE);
    const ww  = Math.min(_W - wx, tw + RANGE * 2);
    const wh  = Math.min(_H - wy, th + RANGE * 2);
    const win = _ctx.getImageData(wx, wy, ww, wh).data;

    let bestMAD = Infinity, bestX = -1, bestY = -1;
    const STEPS = 5;
    for (let i = 0; i < STEPS; i++) {
      for (let j = 0; j < STEPS; j++) {
        const ox = Math.round((i / (STEPS - 1)) * Math.max(0, ww - tw));
        const oy = Math.round((j / (STEPS - 1)) * Math.max(0, wh - th));
        if (ox + tw > ww || oy + th > wh) continue;
        const m = madWindow(win, ww, ox, oy, tw, th);
        if (m < bestMAD) { bestMAD = m; bestX = wx + ox; bestY = wy + oy; }
      }
    }
    if (bestMAD <= TEMPLATE_MAD_THRESHOLD) {
      _lastMAD = bestMAD;
      found = { x: bestX, y: bestY, w: tw, h: th };
    }
  }

  // --- Full grid search (slow path, on jump or initial find) ---
  if (!found) {
    const frame = _ctx.getImageData(0, 0, _W, _H).data;

    const stepX = (_W - tw) / (GRID_DIVISIONS - 1);
    const stepY = (_H - th) / (GRID_DIVISIONS - 1);

    let bestMAD = Infinity, bestX = -1, bestY = -1;

    for (let gy = 0; gy < GRID_DIVISIONS; gy++) {
      for (let gx = 0; gx < GRID_DIVISIONS; gx++) {
        const sx = Math.round(gx * stepX);
        const sy = Math.round(gy * stepY);
        if (sx < 0 || sy < 0 || sx + tw > _W || sy + th > _H) continue;
        const m = madFrame(frame, sx, sy, tw, th);
        if (m < bestMAD) { bestMAD = m; bestX = sx; bestY = sy; }
      }
    }

    // Refine around best grid point (±half a grid step, 5×5 sub-grid)
    if (bestMAD <= TEMPLATE_MAD_POSSIBLE) {
      const refRange = Math.round(stepX / 2);
      const RSTEPS   = 5;
      for (let i = 0; i < RSTEPS; i++) {
        for (let j = 0; j < RSTEPS; j++) {
          const sx = bestX + Math.round((i / (RSTEPS - 1) - 0.5) * 2 * refRange);
          const sy = bestY + Math.round((j / (RSTEPS - 1) - 0.5) * 2 * refRange);
          if (sx < 0 || sy < 0 || sx + tw > _W || sy + th > _H) continue;
          const m = madFrame(frame, sx, sy, tw, th);
          if (m < bestMAD) { bestMAD = m; bestX = sx; bestY = sy; }
        }
      }
      if (bestMAD <= TEMPLATE_MAD_POSSIBLE) {
        _lastMAD = bestMAD;
        found = { x: bestX, y: bestY, w: tw, h: th };
      }
    }
  }

  // --- Update tracking state ---
  if (found) {
    if (_confirmedBox) {
      const d = centroidDist(_confirmedBox, found);
      if (d > JUMP_THRESHOLD) {
        console.log(
          '[HUNTER] Jump:',
          `(${(_confirmedBox.x + _confirmedBox.w / 2) | 0},` +
          `${(_confirmedBox.y + _confirmedBox.h / 2) | 0})`,
          '→',
          `(${(found.x + found.w / 2) | 0},${(found.y + found.h / 2) | 0})`,
          `distance=${Math.round(d)}px`
        );
      }
    }
    _confirmedBox  = found;
    _lastSearchBox = found;
    _missCount     = 0;
  } else {
    _missCount++;
    if (_missCount >= MISS_TOLERANCE) {
      console.log(`[HUNTER] Lost tracking after ${_missCount} miss frames`);
      _confirmedBox  = null;
      _lastSearchBox = null;
    }
  }
}

// MAD against _template using full-frame ImageData (_W-stride)
function madFrame(data, x, y, tw, th) {
  let diff = 0, count = 0;
  for (let dy = 0; dy < th; dy += SEARCH_STEP) {
    for (let dx = 0; dx < tw; dx += SEARCH_STEP) {
      const si = ((y + dy) * _W + (x + dx)) * 4;
      const ti = (dy * tw + dx) * 4;
      diff += Math.abs(data[si]     - _template[ti])
            + Math.abs(data[si + 1] - _template[ti + 1])
            + Math.abs(data[si + 2] - _template[ti + 2]);
      count++;
    }
  }
  return count > 0 ? diff / count : Infinity;
}

// MAD against _template using window ImageData (ww-stride, window-local offsets)
function madWindow(data, ww, ox, oy, tw, th) {
  let diff = 0, count = 0;
  for (let dy = 0; dy < th; dy += SEARCH_STEP) {
    for (let dx = 0; dx < tw; dx += SEARCH_STEP) {
      const si = ((oy + dy) * ww + (ox + dx)) * 4;
      const ti = (dy * tw + dx) * 4;
      diff += Math.abs(data[si]     - _template[ti])
            + Math.abs(data[si + 1] - _template[ti + 1])
            + Math.abs(data[si + 2] - _template[ti + 2]);
      count++;
    }
  }
  return count > 0 ? diff / count : Infinity;
}

function centroidDist(a, b) {
  const ax = a.x + a.w * 0.5, ay = a.y + a.h * 0.5;
  const bx = b.x + b.w * 0.5, by = b.y + b.h * 0.5;
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

// ─── Stage 4: adaptive inpainting ────────────────────────────────────────────
// (Identical to the Sobel version — 4-border bilinear blend + 2-pixel feather.)

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

  const orig = _ctx.getImageData(rx, ry, rw, rh).data;
  const fill = _ctx.createImageData(rw, rh);

  for (let fy = 0; fy < rh; fy++) {
    const t = rh > 1 ? fy / (rh - 1) : 0.5;
    for (let fx = 0; fx < rw; fx++) {
      const s  = rw > 1 ? fx / (rw - 1) : 0.5;
      const fi = (fy * rw + fx) * 4;
      const ci = fx * 3, ri = fy * 3;

      let tbR = 0, tbG = 0, tbB = 0, tbW = 0;
      if (above && below) {
        tbR = above[ci] * (1 - t) + below[ci] * t;
        tbG = above[ci + 1] * (1 - t) + below[ci + 1] * t;
        tbB = above[ci + 2] * (1 - t) + below[ci + 2] * t; tbW = 1;
      } else if (above) { tbR = above[ci]; tbG = above[ci+1]; tbB = above[ci+2]; tbW = 1; }
      else if (below)   { tbR = below[ci]; tbG = below[ci+1]; tbB = below[ci+2]; tbW = 1; }

      let lrR = 0, lrG = 0, lrB = 0, lrW = 0;
      if (left && right) {
        lrR = left[ri] * (1 - s) + right[ri] * s;
        lrG = left[ri + 1] * (1 - s) + right[ri + 1] * s;
        lrB = left[ri + 2] * (1 - s) + right[ri + 2] * s; lrW = 1;
      } else if (left)  { lrR = left[ri];  lrG = left[ri+1];  lrB = left[ri+2];  lrW = 1; }
      else if (right)   { lrR = right[ri]; lrG = right[ri+1]; lrB = right[ri+2]; lrW = 1; }

      const tw2 = tbW + lrW || 1;
      let fR = (tbR * tbW + lrR * lrW) / tw2;
      let fG = (tbG * tbW + lrG * lrW) / tw2;
      let fB = (tbB * tbW + lrB * lrW) / tw2;

      const bd = Math.min(fx, fy, rw - 1 - fx, rh - 1 - fy);
      if (bd < 2) {
        const op = 0.6 + bd * 0.2;
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
//
// Capture phase: yellow dots on hot heat-map cells +
//                HUD "HUNTER: capturing... frame N/60"
// Tracking phase: red box = confirmed, blue box = window search area +
//                 HUD "HUNTER: confirmed=(x,y) MAD=N avgMs=X"

function drawDebugOverlay() {
  _ctx.save();

  if (!_templateCaptured) {
    // Show capture progress
    if (_captureHeatmap) {
      _ctx.fillStyle = 'rgba(255,255,0,0.55)';
      for (let gy = 0; gy < _GH; gy++) {
        for (let gx = 0; gx < _GW; gx++) {
          if (_captureHeatmap[gy * _GW + gx] >= CAPTURE_MIN_FRAMES) {
            _ctx.fillRect(
              gx * CAPTURE_SCAN_STRIDE,
              gy * CAPTURE_SCAN_STRIDE,
              4, 4
            );
          }
        }
      }
    }
    _ctx.fillStyle = 'rgba(0,0,0,0.65)';
    _ctx.fillRect(4, 4, 320, 22);
    _ctx.fillStyle = '#ffee00';
    _ctx.font      = '12px monospace';
    _ctx.fillText(
      `HUNTER: capturing... frame ${_captureCount}/${CAPTURE_FRAMES}`,
      8, 19
    );
  } else {
    // Confirmed box (red)
    if (_confirmedBox) {
      _ctx.strokeStyle = 'rgba(255,0,0,0.9)';
      _ctx.lineWidth   = 2;
      _ctx.strokeRect(_confirmedBox.x, _confirmedBox.y, _confirmedBox.w, _confirmedBox.h);
    }
    // Window search area (blue)
    if (_lastSearchBox && _templateBox) {
      const RANGE = 50;
      _ctx.strokeStyle = 'rgba(0,150,255,0.6)';
      _ctx.lineWidth   = 1;
      _ctx.strokeRect(
        Math.max(0, _lastSearchBox.x - RANGE),
        Math.max(0, _lastSearchBox.y - RANGE),
        _templateBox.w + RANGE * 2,
        _templateBox.h + RANGE * 2
      );
    }
    const cx = _confirmedBox
      ? `(${_confirmedBox.x},${_confirmedBox.y})`
      : 'none';
    _ctx.fillStyle = 'rgba(0,0,0,0.65)';
    _ctx.fillRect(4, 4, 440, 22);
    _ctx.fillStyle = '#00ff88';
    _ctx.font      = '12px monospace';
    _ctx.fillText(
      `HUNTER: confirmed=${cx}  MAD=${_lastMAD.toFixed(0)}  avgMs=${_avgFrameTime.toFixed(1)}`,
      8, 19
    );
  }

  _ctx.restore();
}
