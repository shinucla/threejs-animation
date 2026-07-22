/**
 * Lightweight procedural gunshots (Web Audio). No asset files required.
 * Call unlockAudio() from a user gesture so playback is allowed.
 */

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Resume audio after a click / key — required by browser autoplay rules. */
export function unlockAudio() {
  const ac = getCtx();
  if (ac?.state === 'suspended') ac.resume().catch(() => {});
}

/**
 * Fire a short gunshot blip.
 * @param {{ enemy?: boolean }} [opts]
 */
export function playGunshot(opts = {}) {
  const ac = getCtx();
  if (!ac) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});

  const enemy = !!opts.enemy;
  const t0 = ac.currentTime;
  const duration = enemy ? 0.11 : 0.14;

  // Filtered noise burst (the "crack").
  const n = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buffer = ac.createBuffer(1, n, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const env = Math.pow(1 - i / n, enemy ? 2.2 : 1.8);
    data[i] = (Math.random() * 2 - 1) * env;
  }

  const noise = ac.createBufferSource();
  noise.buffer = buffer;

  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(enemy ? 1400 : 1100, t0);
  filter.frequency.exponentialRampToValueAtTime(enemy ? 600 : 400, t0 + duration);
  filter.Q.value = enemy ? 0.9 : 0.7;

  const noiseGain = ac.createGain();
  noiseGain.gain.setValueAtTime(enemy ? 0.28 : 0.38, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(ac.destination);
  noise.start(t0);
  noise.stop(t0 + duration + 0.02);

  // Low thump under the crack.
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(enemy ? 140 : 110, t0);
  osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.08);

  const thumpGain = ac.createGain();
  thumpGain.gain.setValueAtTime(enemy ? 0.22 : 0.32, t0);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);

  osc.connect(thumpGain);
  thumpGain.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + 0.1);
}
