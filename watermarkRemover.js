// watermarkRemover.js
// Real-time watermark removal using MediaStreamTrackProcessor / Generator.
// Intercepts the raw Decart output stream, detects the semi-transparent
// "＋ AI Generated" pill badge per-frame, inpaints it with surrounding
// content, and returns a clean MediaStream.

// --- Module state ---
let _processor    = null;
let _generator    = null;
let _offscreen    = null;
let _ctx          = null;
let _active       = false;
let _pipeCtrl     = null;   // AbortController for the pipe
let _frameCount   = 0;
let _avgFrameTime = 0;
let _skipDetect   = false;  // adaptive throttle: skip if last frame > 40 ms

// Temporal smoothing state
let _boxHistory   = [];     // rolling buffer of last 3 detected boxes
let _lastBox      = null;   // last accepted box (for persistence across no-detect frames)

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initWatermarkRemover(rawStream) {
  destroyWatermarkRemover();

  const videoTracks = rawStream.getVideoTracks();
  if (!videoTracks.length) {
    console.warn('[WATERMARK] No video track in stream — passing raw stream through');
    return rawStream;
  }

  if (
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined' ||
    typeof VideoFrame                 === 'undefined'
  ) {
    console.warn('[WATERMARK] Insertable Streams API not available — passing raw stream through');
    return rawStream;
  }

  try {
    const videoTrack = videoTracks[0];
    const settings   = videoTrack.getSettings();
    const W = settings.width  || 1280;
    const H = settings.height || 720;

    _offscreen = new OffscreenCanvas(W, H);
    _ctx = _offscreen.getContext('2d', { willReadFrequently: true });

    _processor = new MediaStreamTrackProcessor({ track: videoTrack });
    _generator = new MediaStreamTrackGenerator({ kind: 'video' });

    const transformStream = new TransformStream({
      transform(videoFrame, controller) {
        const t0 = performance.now();
        let cleanFrame = null;
        try {
          _ctx.drawImage(videoFrame, 0, 0, W, H);

          let region = null;
          if (!_skipDetect) {
            const imageData = _ctx.getImageData(0, 0, W, H);
            region = detectWatermarkRegion(imageData);
            region = applyTemporalSmoothing(region);
            if (region) inpaintRegion(_ctx, region.x, region.y, region.w, region.h);
          }

          const init = { timestamp: videoFrame.timestamp };
          if (videoFrame.duration != null) init.duration = videoFrame.duration;
          cleanFrame = new VideoFrame(_offscreen, init);

          const elapsed = performance.now() - t0;
          _skipDetect = elapsed > 40;
          _frameCount++;
          _avgFrameTime += (elapsed - _avgFrameTime) / _frameCount;

          if (_frameCount % 30 === 0) {
            const box = region
              ? `(${region.x},${region.y},${region.w}×${region.h})`
              : 'none';
            console.log(
              `[WATERMARK] Frame ${_frameCount}: detected=${!!region}`,
              `box=${box}`,
              `avgTime=${_avgFrameTime.toFixed(1)}ms`
            );
          }

          videoFrame.close();
          controller.enqueue(cleanFrame);
        } catch (err) {
          console.warn('[WATERMARK] Frame processing error:', err.message);
          if (cleanFrame) { try { cleanFrame.close(); } catch (_) {} }
          try {
            controller.enqueue(videoFrame);
          } catch (_) {
            try { videoFrame.close(); } catch (_) {}
          }
        }
      },
    });

    _pipeCtrl = new AbortController();
    _processor.readable
      .pipeThrough(transformStream)
      .pipeTo(_generator.writable, { signal: _pipeCtrl.signal })
      .catch(err => {
        if (err?.name !== 'AbortError') {
          console.error('[WATERMARK] Pipeline error:', err);
        }
      });

    const audioTracks = rawStream.getAudioTracks();
    const cleanStream = new MediaStream([_generator, ...audioTracks]);

    _active = true;
    console.log(`[WATERMARK] Initialized — ${W}×${H}, pipeline active`);
    return cleanStream;
  } catch (err) {
    console.error('[WATERMARK] Init failed — falling back to raw stream:', err);
    destroyWatermarkRemover();
    return rawStream;
  }
}

export function destroyWatermarkRemover() {
  const wasActive = _active;
  if (_pipeCtrl) {
    try { _pipeCtrl.abort(); } catch (_) {}
    _pipeCtrl = null;
  }
  _processor    = null;
  _generator    = null;
  _offscreen    = null;
  _ctx          = null;
  _active       = false;
  _frameCount   = 0;
  _avgFrameTime = 0;
  _skipDetect   = false;
  _boxHistory   = [];
  _lastBox      = null;
  if (wasActive) console.log('[WATERMARK] Destroyed');
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }

// ─── Temporal smoothing ─────────────────────────────────────────────────────
//
// Rolling buffer of last 3 accepted boxes. If the new detection is within
// 50 px of the centroid average, smooth it in. If > 100 px away the badge
// has jumped — accept immediately, reset history, and log the jump.

function applyTemporalSmoothing(detected) {
  if (!detected) {
    // No detection this frame — return last accepted box for persistence
    return _lastBox;
  }

  if (_boxHistory.length === 0) {
    _boxHistory.push(detected);
    _lastBox = detected;
    return detected;
  }

  const avgX = _boxHistory.reduce((s, b) => s + b.x, 0) / _boxHistory.length;
  const avgY = _boxHistory.reduce((s, b) => s + b.y, 0) / _boxHistory.length;
  const dist = Math.sqrt(
    (detected.x - avgX) ** 2 +
    (detected.y - avgY) ** 2
  );

  if (dist > 100) {
    // Badge jumped to a new position — log and reset buffer
    const oldX = Math.round(avgX), oldY = Math.round(avgY);
    console.log(
      `[WATERMARK] Position jump detected:`,
      `old=(${oldX},${oldY})`,
      `new=(${detected.x},${detected.y})`,
      `distance=${Math.round(dist)}px`
    );
    _boxHistory = [detected];
    _lastBox    = detected;
    return detected;
  }

  // Smooth: average with history
  _boxHistory.push(detected);
  if (_boxHistory.length > 3) _boxHistory.shift();

  const smoothed = {
    x: Math.round(_boxHistory.reduce((s, b) => s + b.x, 0) / _boxHistory.length),
    y: Math.round(_boxHistory.reduce((s, b) => s + b.y, 0) / _boxHistory.length),
    w: Math.round(_boxHistory.reduce((s, b) => s + b.w, 0) / _boxHistory.length),
    h: Math.round(_boxHistory.reduce((s, b) => s + b.h, 0) / _boxHistory.length),
  };
  _lastBox = smoothed;
  return smoothed;
}

// ─── Detection ──────────────────────────────────────────────────────────────
//
// Full-frame scan every call — no position caching. Per-row, finds the
// widest contiguous run of pixels where R>185 AND G>185 AND B>185 (threshold
// covers semi-transparent white at 0.6–0.8 alpha over typical video).
// Groups vertically adjacent matching rows whose extents overlap ≥ 40 px.
// Validates bounding box: 60–280 px wide, ≤ 60 px tall, w/h ≥ 1.5.
// Returns the highest-scoring candidate (most rows × width) or null.

function detectWatermarkRegion(imageData) {
  const { data, width, height } = imageData;
  const STRIDE = 6;
  const THRESH = 185;

  const rowRuns = [];
  for (let y = 0; y < height; y += STRIDE) {
    let runStart = -1, runW = 0, bestW = 0, bestX = -1;
    for (let x = 0; x < width; x += STRIDE) {
      const i = (y * width + x) * 4;
      if (data[i] > THRESH && data[i + 1] > THRESH && data[i + 2] > THRESH) {
        if (runStart < 0) runStart = x;
        runW += STRIDE;
      } else {
        if (runW > bestW) { bestW = runW; bestX = runStart; }
        runStart = -1; runW = 0;
      }
    }
    if (runW > bestW) { bestW = runW; bestX = runStart; }
    rowRuns.push(bestW >= 60 && bestW <= 280 && bestX >= 0
      ? { y, x: bestX, w: bestW }
      : null);
  }

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
    const maxY = group[group.length - 1].y + STRIDE;
    const bh   = maxY - minY;
    if (bh > 60)                        continue;
    if (bw / Math.max(bh, 1) < 1.5)    continue;

    const score = group.length * bw;
    if (!best || score > best.score) {
      best = { x: gMinX, y: minY, w: bw, h: bh, score };
    }
  }

  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}

// ─── Inpainting ─────────────────────────────────────────────────────────────
//
// Sample 16-pixel strips above and below the detected region (+ 4 px pad),
// column-average each strip, then fill the region with a vertical linear
// interpolation between the two reference rows.

function inpaintRegion(ctx, x, y, w, h) {
  const PAD  = 4;
  const SAMP = 16;

  const rx = Math.max(0, x - PAD);
  const ry = Math.max(0, y - PAD);
  const rw = Math.min(ctx.canvas.width  - rx, w + PAD * 2);
  const rh = Math.min(ctx.canvas.height - ry, h + PAD * 2);

  const aboveY   = ry - SAMP;
  const hasAbove = aboveY >= 0;
  const belowY   = ry + rh;
  const hasBelow = belowY + SAMP <= ctx.canvas.height;

  if (!hasAbove && !hasBelow) return;

  function columnAvg(pixels, cols, rows) {
    const out = new Float32Array(cols * 3);
    for (let c = 0; c < cols; c++) {
      let r = 0, g = 0, b = 0;
      for (let row = 0; row < rows; row++) {
        const i = (row * cols + c) * 4;
        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
      }
      out[c * 3]     = r / rows;
      out[c * 3 + 1] = g / rows;
      out[c * 3 + 2] = b / rows;
    }
    return out;
  }

  const above = hasAbove
    ? columnAvg(ctx.getImageData(rx, aboveY, rw, SAMP).data, rw, SAMP)
    : null;
  const below = hasBelow
    ? columnAvg(ctx.getImageData(rx, belowY, rw, SAMP).data, rw, SAMP)
    : null;

  const fill = ctx.createImageData(rw, rh);
  for (let fy = 0; fy < rh; fy++) {
    const t = rh > 1 ? fy / (rh - 1) : 0.5;
    for (let fx = 0; fx < rw; fx++) {
      const fi = (fy * rw + fx) * 4;
      const ci = fx * 3;
      let rv, gv, bv;
      if (above && below) {
        rv = above[ci]     * (1 - t) + below[ci]     * t;
        gv = above[ci + 1] * (1 - t) + below[ci + 1] * t;
        bv = above[ci + 2] * (1 - t) + below[ci + 2] * t;
      } else if (above) {
        rv = above[ci]; gv = above[ci + 1]; bv = above[ci + 2];
      } else {
        rv = below[ci]; gv = below[ci + 1]; bv = below[ci + 2];
      }
      fill.data[fi]     = (rv + 0.5) | 0;
      fill.data[fi + 1] = (gv + 0.5) | 0;
      fill.data[fi + 2] = (bv + 0.5) | 0;
      fill.data[fi + 3] = 255;
    }
  }

  ctx.putImageData(fill, rx, ry);
}
