// watermarkHunter.js — hardcoded zone coverage
//
// No detection. No template matching. No brightness scan.
// Every frame: inpaint all known watermark positions.
//
// Zones were derived from Sobel-session confirmed detections (scores 58-95,
// width 70-100px, height 18-32px) with ±30px padding on each side.
//
// To add new zones in future:
//   1. Check out the data-collection tag (git checkout v-data-collect)
//   2. Start sessions and run:  console.table(window._getWatermarkPositions())
//   3. Filter for width < 130 AND height < 40 — those are real watermark hits.
//      Entries with width > 150 are false positives (face / wall highlights).
//   4. Expand by ±30px and add to WATERMARK_ZONES below.
//
// Public API is identical to watermarkRemover.js.

// ─── Hardcoded watermark zones ────────────────────────────────────────────────

const WATERMARK_ZONES = [
  // Right-side cluster
  { x: 1140, y: 410, w: 160, h: 60 },  // confirmed (1198,444,80×20) score=70
  { x: 1170, y: 415, w: 160, h: 60 },  // confirmed (1232,453,90×22) score=69
  { x: 1125, y: 625, w: 170, h: 60 },  // confirmed (1165,658,96×23) score=67
  { x: 1140, y: 395, w: 160, h: 55 },  // confirmed (1188,442,90×22) score=69

  // Center-right cluster
  { x: 800,  y: 500, w: 160, h: 60 },  // confirmed (858,538,86×20)  score=95
  { x: 570,  y: 525, w: 155, h: 65 },  // confirmed (585,508,72×24)  score=60
  { x: 575,  y: 535, w: 155, h: 65 },  // confirmed (566,562,79×28)  score=60 / (637,568,72×21)
  { x: 570,  y: 235, w: 155, h: 60 },  // confirmed (616,276,88×28)  score=67 / (618,334)
  { x: 640,  y: 135, w: 155, h: 60 },  // estimated  (745,180,90×25)
  { x: 570,  y: 125, w: 155, h: 60 },  // estimated  (620,166,90×25)

  // Left-side cluster
  { x: 370,  y: 600, w: 160, h: 65 },  // confirmed (432,642,88×22)  score=70
  { x: 370,  y: 145, w: 155, h: 60 },  // confirmed (431,187,79×21)  score=70
  { x: 65,   y: 40,  w: 165, h: 60 },  // confirmed (128,76,100×20)  score=86
  { x: 170,  y: 305, w: 155, h: 65 },  // confirmed (232,342,80×32)  score=58
  { x: 205,  y: 320, w: 160, h: 60 },  // estimated  (270,358,90×25)
  { x: 250,  y: 490, w: 155, h: 60 },  // estimated  (318,525,90×25)
];

// ─── Inpaint constants ────────────────────────────────────────────────────────

const INPAINT_SAMP = 12;

// ─── Module state ─────────────────────────────────────────────────────────────

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

// ─── Public API ───────────────────────────────────────────────────────────────

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
        const t0 = performance.now();
        let clean = null;
        try {
          _ctx.drawImage(videoFrame, 0, 0, _W, _H);

          for (const zone of WATERMARK_ZONES) {
            inpaintBox(zone);
          }

          if (typeof window !== 'undefined' && window._loqiiWatermarkDebug) {
            drawDebugOverlay();
          }

          const init = { timestamp: videoFrame.timestamp };
          if (videoFrame.duration != null) init.duration = videoFrame.duration;
          clean = new VideoFrame(_canvas, init);

          const ms = performance.now() - t0;
          _frameCount++;
          _avgFrameTime = _avgFrameTime * 0.95 + ms * 0.05;

          if (_frameCount % 120 === 0) {
            console.log(
              '[HUNTER] Frame', _frameCount,
              'avgMs:', _avgFrameTime.toFixed(1),
              'zones:', WATERMARK_ZONES.length
            );
          }

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
    console.log(
      `[HUNTER] Initialized — ${_W}×${_H}, covering ${WATERMARK_ZONES.length} zones`
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
  _frameCount = 0; _avgFrameTime = 0;
  if (was) console.log('[HUNTER] Destroyed');
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }

// ─── Adaptive inpainting ──────────────────────────────────────────────────────
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
// window._loqiiWatermarkDebug = true
// Semi-transparent blue rectangles over all zones + stats HUD.

function drawDebugOverlay() {
  _ctx.save();

  _ctx.strokeStyle = 'rgba(0,150,255,0.7)';
  _ctx.fillStyle   = 'rgba(0,100,200,0.15)';
  _ctx.lineWidth   = 1;
  for (const zone of WATERMARK_ZONES) {
    _ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
    _ctx.strokeRect(zone.x, zone.y, zone.w, zone.h);
  }

  _ctx.fillStyle = 'rgba(0,0,0,0.65)';
  _ctx.fillRect(4, 4, 340, 22);
  _ctx.fillStyle = '#00aaff';
  _ctx.font      = '12px monospace';
  _ctx.fillText(
    `HUNTER: zones=${WATERMARK_ZONES.length}  avgMs=${_avgFrameTime.toFixed(1)}`,
    8, 19
  );

  _ctx.restore();
}
