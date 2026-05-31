// watermarkHunter.js — DATA COLLECTION MODE
//
// Detects watermark positions using the brightness-scan row-run approach
// (the original method that consistently scored 67-95) and logs every
// confirmed position to console + localStorage.
//
// DATA_COLLECTION_MODE = true  → detect and log only, NO inpainting.
//                              Run 5-10 sessions, then call:
//                                console.table(window._getWatermarkPositions())
//                              to see the full position map.
//
// DATA_COLLECTION_MODE = false → inpainting enabled (for future hardcoded zones).
//
// Public API identical to watermarkRemover.js.

// ─── Mode flag ───────────────────────────────────────────────────────────────

const DATA_COLLECTION_MODE = true;

// ─── Detection constants ──────────────────────────────────────────────────────

const DETECT_STRIDE = 6;     // pixel stride for brightness scan
const DETECT_THRESH = 185;   // R/G/B threshold — all channels must exceed this
const DETECT_MIN_W  = 60;    // min badge width in px
const DETECT_MAX_W  = 280;   // max badge width in px
const DETECT_MAX_H  = 60;    // max badge height in px
const DETECT_MIN_ASPECT = 1.5;

// ─── Tracking constants ───────────────────────────────────────────────────────

const CONFIRM_FRAMES  = 2;   // consecutive frames at same position before logging
const MISS_TOLERANCE  = 8;   // frames without detection before clearing confirmed box
const CONFIRM_DIST    = 15;  // px — candidate must stay within this to accumulate
const LOG_MIN_DIST    = 20;  // px — log new entry only if centroid moved this far

// ─── Inpainting constant (used when DATA_COLLECTION_MODE = false) ─────────────

const INPAINT_SAMP = 12;

// ─── Module state ────────────────────────────────────────────────────────────

let _proc      = null;
let _gen       = null;
let _canvas    = null;
let _ctx       = null;
let _active    = false;
let _pipeCtrl  = null;
let _W         = 1280;
let _H         = 720;
let _frameCount   = 0;
let _avgFrameTime = 0;
let _skipBudget   = false;

// Tracking state
let _confirmedBox   = null;
let _candidateBox   = null;
let _candidateCount = 0;
let _missCount      = 0;

// Data collection state
let _sessionPositions = [];
let _sessionId        = Date.now().toString(36);

// ─── localStorage helper (available as soon as module loads) ──────────────────

if (typeof window !== 'undefined') {
  window._getWatermarkPositions = () => {
    try {
      return JSON.parse(localStorage.getItem('loqii_watermark_positions') || '[]');
    } catch {
      return [];
    }
  };
  window._clearWatermarkPositions = () => {
    localStorage.removeItem('loqii_watermark_positions');
    console.log('[HUNTER] Position log cleared');
  };
}

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

    _canvas = new OffscreenCanvas(_W, _H);
    _ctx    = _canvas.getContext('2d', { willReadFrequently: true });

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
            const imageData = _ctx.getImageData(0, 0, _W, _H);
            detectAndTrack(imageData);

            // Only inpaint when not collecting data
            if (!DATA_COLLECTION_MODE && _confirmedBox) {
              inpaintBox(_confirmedBox);
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
    _active    = true;
    _sessionId = Date.now().toString(36);
    _sessionPositions = [];
    console.log(
      `[HUNTER] Initialized — ${_W}×${_H}` +
      ` | DATA_COLLECTION_MODE=${DATA_COLLECTION_MODE}` +
      ` | session=${_sessionId}`
    );
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
  _proc = _gen = _canvas = _ctx = null;
  _active = false; _W = 1280; _H = 720;
  _frameCount = 0; _avgFrameTime = 0; _skipBudget = false;
  _confirmedBox = null; _candidateBox = null; _candidateCount = 0;
  _missCount = 0;
  if (was) {
    console.log(
      `[HUNTER] Destroyed — session ${_sessionId}` +
      ` logged ${_sessionPositions.length} positions`
    );
  }
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }

// ─── Detection: brightness-scan row-run ───────────────────────────────────────
//
// For each row (stride 6), find the widest contiguous run of pixels where
// R > 185 AND G > 185 AND B > 185 (semi-transparent white over any background).
// Group vertically adjacent matching rows whose horizontal extents overlap by
// ≥ 40px. Validate bounding box dimensions and aspect ratio.
// Score 0-100: density component (row count) + aspect component.

function detectWatermark(imageData) {
  const { data, width, height } = imageData;

  // Per-row: find widest qualifying bright run
  const rowRuns = [];
  for (let y = 0; y < height; y += DETECT_STRIDE) {
    let rs = -1, rw = 0, bestW = 0, bestX = -1;
    for (let x = 0; x < width; x += DETECT_STRIDE) {
      const i = (y * width + x) * 4;
      if (data[i] > DETECT_THRESH && data[i+1] > DETECT_THRESH && data[i+2] > DETECT_THRESH) {
        if (rs < 0) rs = x;
        rw += DETECT_STRIDE;
      } else {
        if (rw > bestW) { bestW = rw; bestX = rs; }
        rs = -1; rw = 0;
      }
    }
    if (rw > bestW) { bestW = rw; bestX = rs; }
    rowRuns.push(
      bestW >= DETECT_MIN_W && bestW <= DETECT_MAX_W && bestX >= 0
        ? { y, x: bestX, w: bestW }
        : null
    );
  }

  // Group vertically contiguous rows (allow 1 gap row)
  let best = null;
  for (let i = 0; i < rowRuns.length; i++) {
    if (!rowRuns[i]) continue;

    const group = [rowRuns[i]];
    let gMinX = rowRuns[i].x;
    let gMaxX = rowRuns[i].x + rowRuns[i].w;
    let gaps  = 0;

    for (let j = i + 1; j < rowRuns.length; j++) {
      if (!rowRuns[j]) {
        if (++gaps > 1) break;
        continue;
      }
      const row     = rowRuns[j];
      const overlap = Math.min(row.x + row.w, gMaxX) - Math.max(row.x, gMinX);
      if (overlap < 40) break;
      group.push(row);
      if (row.x         < gMinX) gMinX = row.x;
      if (row.x + row.w > gMaxX) gMaxX = row.x + row.w;
    }

    if (group.length < 2) continue;

    const bw   = gMaxX - gMinX;
    const minY = group[0].y;
    const maxY = group[group.length - 1].y + DETECT_STRIDE;
    const bh   = maxY - minY;
    if (bh > DETECT_MAX_H)                  continue;
    if (bw / Math.max(bh, 1) < DETECT_MIN_ASPECT) continue;

    // Score 0-100: aspect quality (0-50) + row density (0-50)
    const aspect      = bw / Math.max(bh, 1);
    const aspectScore = Math.max(0, 50 - Math.abs(aspect - 4.0) * 6);
    const densityScore = Math.min(50, group.length * 10);
    const score = Math.round(aspectScore + densityScore);

    if (!best || score > best.score) {
      best = { x: gMinX, y: minY, w: bw, h: bh, score };
    }
  }

  return best;
}

// ─── Temporal tracking ───────────────────────────────────────────────────────
//
// Requires CONFIRM_FRAMES consecutive detections within CONFIRM_DIST px before
// logging. Logs a new entry only when centroid moves > LOG_MIN_DIST px from the
// last logged position. Clears after MISS_TOLERANCE consecutive misses.

function detectAndTrack(imageData) {
  const candidate = detectWatermark(imageData);

  if (!candidate) {
    _missCount++;
    if (_missCount >= MISS_TOLERANCE) {
      _confirmedBox   = null;
      _candidateBox   = null;
      _candidateCount = 0;
    }
    return;
  }

  _missCount = 0;

  if (_candidateBox && centroidDist(_candidateBox, candidate) <= CONFIRM_DIST) {
    _candidateCount++;
    _candidateBox = candidate;

    if (_candidateCount >= CONFIRM_FRAMES) {
      const isNewPosition = !_confirmedBox ||
        centroidDist(_confirmedBox, candidate) > LOG_MIN_DIST;

      _confirmedBox = { ...candidate };

      if (isNewPosition) {
        logPosition(candidate);
      }
    }
  } else {
    _candidateBox   = candidate;
    _candidateCount = 1;
  }
}

function centroidDist(a, b) {
  const ax = a.x + a.w * 0.5, ay = a.y + a.h * 0.5;
  const bx = b.x + b.w * 0.5, by = b.y + b.h * 0.5;
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

// ─── Position logging ─────────────────────────────────────────────────────────

function logPosition(box) {
  const entry = {
    x:       box.x,
    y:       box.y,
    w:       box.w,
    h:       box.h,
    score:   box.score,
    frame:   _frameCount,
    session: _sessionId,
    ts:      Date.now(),
  };

  console.log(
    `[POSITION] (${box.x},${box.y},${box.w}×${box.h})` +
    ` score=${box.score} frame=${_frameCount} session=${_sessionId}`
  );

  _sessionPositions.push(entry);

  if (typeof localStorage !== 'undefined') {
    try {
      const existing = JSON.parse(
        localStorage.getItem('loqii_watermark_positions') || '[]'
      );
      existing.push(entry);
      localStorage.setItem('loqii_watermark_positions', JSON.stringify(existing));
    } catch (err) {
      console.warn('[HUNTER] localStorage write failed:', err.message);
    }
  }
}

// ─── Adaptive inpainting (active when DATA_COLLECTION_MODE = false) ───────────
// 4-border bilinear blend + 2-pixel edge feather.

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
        r += d[i]; g += d[i+1]; b += d[i+2];
      }
      o[c*3]=r/rows; o[c*3+1]=g/rows; o[c*3+2]=b/rows;
    }
    return o;
  }

  function rowAvg(d, cols, rows) {
    const o = new Float32Array(rows * 3);
    for (let r = 0; r < rows; r++) {
      let rv = 0, gv = 0, bv = 0;
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        rv += d[i]; gv += d[i+1]; bv += d[i+2];
      }
      o[r*3]=rv/cols; o[r*3+1]=gv/cols; o[r*3+2]=bv/cols;
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
        tbR = above[ci]*(1-t)+below[ci]*t;
        tbG = above[ci+1]*(1-t)+below[ci+1]*t;
        tbB = above[ci+2]*(1-t)+below[ci+2]*t; tbW = 1;
      } else if (above) { tbR=above[ci]; tbG=above[ci+1]; tbB=above[ci+2]; tbW=1; }
      else if (below)   { tbR=below[ci]; tbG=below[ci+1]; tbB=below[ci+2]; tbW=1; }

      let lrR = 0, lrG = 0, lrB = 0, lrW = 0;
      if (left && right) {
        lrR = left[ri]*(1-s)+right[ri]*s;
        lrG = left[ri+1]*(1-s)+right[ri+1]*s;
        lrB = left[ri+2]*(1-s)+right[ri+2]*s; lrW = 1;
      } else if (left)  { lrR=left[ri];  lrG=left[ri+1];  lrB=left[ri+2];  lrW=1; }
      else if (right)   { lrR=right[ri]; lrG=right[ri+1]; lrB=right[ri+2]; lrW=1; }

      const tw = tbW + lrW || 1;
      let fR = (tbR*tbW + lrR*lrW) / tw;
      let fG = (tbG*tbW + lrG*lrW) / tw;
      let fB = (tbB*tbW + lrB*lrW) / tw;

      const bd = Math.min(fx, fy, rw-1-fx, rh-1-fy);
      if (bd < 2) {
        const op = 0.6 + bd * 0.2;
        fR = fR*op + orig[fi]   *(1-op);
        fG = fG*op + orig[fi+1] *(1-op);
        fB = fB*op + orig[fi+2] *(1-op);
      }

      fill.data[fi]   = (fR+0.5)|0;
      fill.data[fi+1] = (fG+0.5)|0;
      fill.data[fi+2] = (fB+0.5)|0;
      fill.data[fi+3] = 255;
    }
  }

  _ctx.putImageData(fill, rx, ry);
}

// ─── Debug overlay ────────────────────────────────────────────────────────────
//
// window._loqiiWatermarkDebug = true
// Yellow box = candidate, Red box = confirmed
// HUD shows mode, position count, score, avgMs

function drawDebugOverlay() {
  _ctx.save();

  if (_candidateBox) {
    _ctx.strokeStyle = 'rgba(255,255,0,0.7)';
    _ctx.lineWidth   = 1;
    _ctx.strokeRect(_candidateBox.x, _candidateBox.y, _candidateBox.w, _candidateBox.h);
  }
  if (_confirmedBox) {
    _ctx.strokeStyle = 'rgba(255,0,0,0.9)';
    _ctx.lineWidth   = 2;
    _ctx.strokeRect(_confirmedBox.x, _confirmedBox.y, _confirmedBox.w, _confirmedBox.h);
  }

  const mode = DATA_COLLECTION_MODE ? 'COLLECT' : 'INPAINT';
  const cx   = _confirmedBox
    ? `(${_confirmedBox.x},${_confirmedBox.y} ${_confirmedBox.w}×${_confirmedBox.h})`
    : 'none';
  _ctx.fillStyle = 'rgba(0,0,0,0.65)';
  _ctx.fillRect(4, 4, 500, 22);
  _ctx.fillStyle = DATA_COLLECTION_MODE ? '#ffee00' : '#00ff88';
  _ctx.font      = '12px monospace';
  _ctx.fillText(
    `HUNTER[${mode}]: ${cx}  n=${_sessionPositions.length}  avgMs=${_avgFrameTime.toFixed(1)}`,
    8, 19
  );

  _ctx.restore();
}
