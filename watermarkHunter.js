// watermarkHunter.js — IPC-based watermark removal pipeline
//
// Each video frame is:
//   1. Drawn to an OffscreenCanvas (renderer)
//   2. Read as raw RGBA via getImageData
//   3. Sent to the Electron main process via window.tzurah.processWatermarkFrame
//   4. Processed by watermarkSharp.js (Sharp + libvips detection + inpainting)
//   5. Written back to the canvas via putImageData
//   6. Wrapped in a new VideoFrame and enqueued to the generator
//
// Fallback: any error at any stage passes the original VideoFrame through
// unchanged, so the session never crashes.
//
// Performance optimisation: when Sharp found no watermark on the last frame,
// the next frame skips the IPC call entirely (reuses last clean canvas).
// This halves IPC overhead during the majority of frames where the watermark
// is not visible or has not changed position.
//
// Public API identical to watermarkRemover.js.

// ─── Module state ─────────────────────────────────────────────────────────────

let _processor    = null;
let _generator    = null;
let _pipeCtrl     = null;
let _canvas       = null;
let _ctx          = null;
let _active       = false;
let _frameCount   = 0;
let _avgFrameTime = 0;

// Skip-frame optimisation
let _lastHadWatermark = false;
let _skipNext         = false;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function initWatermarkRemover(rawStream) {
  destroyWatermarkRemover();

  // Require IPC bridge
  if (!window.tzurah?.processWatermarkFrame) {
    console.warn('[HUNTER] IPC bridge (tzurah.processWatermarkFrame) not available — using raw stream');
    return rawStream;
  }

  const videoTracks = rawStream.getVideoTracks();
  if (!videoTracks.length) {
    console.warn('[HUNTER] No video track — using raw stream');
    return rawStream;
  }

  if (
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined' ||
    typeof VideoFrame                 === 'undefined'
  ) {
    console.warn('[HUNTER] Insertable Streams API unavailable — using raw stream');
    return rawStream;
  }

  try {
    const track    = videoTracks[0];
    const settings = track.getSettings();
    const W = settings.width  || 1280;
    const H = settings.height || 720;

    _canvas = new OffscreenCanvas(W, H);
    _ctx    = _canvas.getContext('2d', { willReadFrequently: true });

    _processor = new MediaStreamTrackProcessor({ track });
    _generator = new MediaStreamTrackGenerator({ kind: 'video' });

    const ts = new TransformStream({
      async transform(videoFrame, controller) {
        _frameCount++;
        const t0 = performance.now();
        let clean = null;
        try {
          // Save timestamp before close
          const ts        = videoFrame.timestamp;
          const duration  = videoFrame.duration;

          _ctx.drawImage(videoFrame, 0, 0, W, H);
          videoFrame.close();

          // Skip IPC every other frame when last frame had no watermark
          const doProcess = _lastHadWatermark || !_skipNext;
          _skipNext = !_skipNext;

          if (doProcess) {
            const imageData  = _ctx.getImageData(0, 0, W, H);
            const rgbaBuffer = imageData.data.buffer;

            const cleanBuffer = await window.tzurah.processWatermarkFrame(rgbaBuffer);

            // Detect whether Sharp found something (returned different buffer)
            // We use buffer identity — same object = no change = no watermark
            const hadWatermark = cleanBuffer !== rgbaBuffer;
            _lastHadWatermark  = hadWatermark;

            if (hadWatermark) {
              const cleanData = new ImageData(
                new Uint8ClampedArray(cleanBuffer),
                W, H
              );
              _ctx.putImageData(cleanData, 0, 0);
            }
          }

          const init = { timestamp: ts };
          if (duration != null) init.duration = duration;
          clean = new VideoFrame(_canvas, init);

          const ms = performance.now() - t0;
          _avgFrameTime = _avgFrameTime * 0.95 + ms * 0.05;

          if (_frameCount % 120 === 0) {
            console.log(
              '[HUNTER] Frame', _frameCount,
              'avgMs:', _avgFrameTime.toFixed(1),
              'watermark:', _lastHadWatermark
            );
          }

          controller.enqueue(clean);
        } catch (err) {
          console.error('[HUNTER] Frame error:', err.message);
          if (clean) { try { clean.close(); } catch (_) {} }
          // Enqueue a frame from whatever is on canvas to keep pipeline alive
          try {
            const init  = {};
            const frame = new VideoFrame(_canvas, init);
            controller.enqueue(frame);
          } catch (_) {}
        }
      },
    });

    _pipeCtrl = new AbortController();
    _processor.readable
      .pipeThrough(ts)
      .pipeTo(_generator.writable, { signal: _pipeCtrl.signal })
      .catch(err => {
        if (err?.name !== 'AbortError') console.error('[HUNTER] Pipeline error:', err);
      });

    const cleanStream = new MediaStream([_generator, ...rawStream.getAudioTracks()]);
    _active = true;
    console.log(`[HUNTER] Initialized — Sharp IPC pipeline active (${W}×${H})`);
    return cleanStream;
  } catch (err) {
    console.error('[HUNTER] Init failed — raw stream fallback:', err);
    destroyWatermarkRemover();
    return rawStream;
  }
}

export function destroyWatermarkRemover() {
  const was = _active;
  if (_pipeCtrl) { try { _pipeCtrl.abort(); } catch (_) {} _pipeCtrl = null; }
  _processor = _generator = _canvas = _ctx = null;
  _active = false; _frameCount = 0; _avgFrameTime = 0;
  _lastHadWatermark = false; _skipNext = false;
  if (was) console.log('[HUNTER] Destroyed');
}

export function isWatermarkRemoverActive() { return _active; }
export function getAverageFrameTime()      { return _avgFrameTime; }
