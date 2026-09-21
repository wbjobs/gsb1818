import { Attributor } from './attribution.js';

let attributor = null;

function send(type, payload = {}) {
  self.postMessage({ type, payload });
}

self.onmessage = (event) => {
  const { type, payload = {} } = event.data || {};

  try {
    if (type === 'start') {
      attributor = new Attributor({ targetFps: payload.targetFps, maxFrames: payload.maxFrames });
      send('started');
      return;
    }

    if (!attributor) {
      send('error', { message: 'Worker 尚未开始采集' });
      return;
    }

    if (type === 'entries') {
      for (const [entryType, items] of Object.entries(payload.entries || {})) {
        for (const item of items) attributor.addEntry(entryType, item);
      }
      return;
    }

    if (type === 'batch') {
      for (const frame of payload.frames || []) {
        attributor.addFrame(frame);
      }
      const recent = attributor.frames.slice(-60).filter((frame) => !frame.hidden);
      const total = recent.reduce((sum, frame) => sum + frame.duration, 0) || 1;
      send('live', {
        fps: Math.round(recent.length / (total / 1000)),
        frames: attributor.frames.length,
        lastFrame: attributor.frames.at(-1) ? attributor.attributeFrame({ ...attributor.frames.at(-1) }) : null,
      });
      return;
    }

    if (type === 'warning') {
      attributor.addWarning(payload.code, payload.message);
      return;
    }

    if (type === 'analyze') {
      const report = attributor.analyze(payload);
      send('report', report);
      return;
    }

    if (type === 'reset') {
      attributor = new Attributor({ targetFps: payload.targetFps || 60 });
      send('reset');
    }
  } catch (error) {
    send('error', { message: error?.message || String(error), stack: error?.stack });
  }
};
