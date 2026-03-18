// ─── Audio Effects Engine (Per-Track) ───
// Single audio chain, per-track settings that swap when track changes

const FX = {
  ctx: null,
  connected: false,
  nodes: {},
  activeTrack: 0,
  trackStates: {},  // trackIndex -> state
};

function defaultFxState() {
  return {
    eq: { low: 0, mid: 0, high: 0 },
    reverb: { mix: 0, decay: 2.5 },
    delay: { mix: 0, time: 0.35, feedback: 0.3 },
    compressor: { on: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 },
    distortion: { mix: 0, gain: 50 },
    master: 1.0
  };
}

function getTrackFxState(trackIndex) {
  if (!FX.trackStates[trackIndex]) {
    FX.trackStates[trackIndex] = defaultFxState();
  }
  return FX.trackStates[trackIndex];
}

function initEffects() {
  if (!api || !api.player) return;
  const check = setInterval(() => {
    const output = api.player.output;
    if (output && output.context && output._worklet) {
      clearInterval(check);
      setupEffectsChain(output);
    }
  }, 500);
}

function setupEffectsChain(output) {
  if (FX.connected) return;

  const ctx = output.context;
  FX.ctx = ctx;

  // EQ: 3-band
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf'; eqLow.frequency.value = 200; eqLow.gain.value = 0;
  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1.0; eqMid.gain.value = 0;
  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000; eqHigh.gain.value = 0;

  // Compressor
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -24; compressor.ratio.value = 4;
  compressor.attack.value = 0.003; compressor.release.value = 0.25; compressor.knee.value = 10;
  const compDry = ctx.createGain(); compDry.gain.value = 1;
  const compWet = ctx.createGain(); compWet.gain.value = 0;
  const compMerge = ctx.createGain();

  // Distortion
  const distDry = ctx.createGain(); distDry.gain.value = 1;
  const distWet = ctx.createGain(); distWet.gain.value = 0;
  const distShaper = ctx.createWaveShaper();
  distShaper.curve = makeDistortionCurve(50); distShaper.oversample = '4x';
  const distMerge = ctx.createGain();

  // Reverb
  const reverbDry = ctx.createGain(); reverbDry.gain.value = 1;
  const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;
  const convolver = ctx.createConvolver();
  convolver.buffer = generateImpulseResponse(ctx, 2.5);
  const reverbMerge = ctx.createGain();

  // Delay
  const delayDry = ctx.createGain(); delayDry.gain.value = 1;
  const delayWet = ctx.createGain(); delayWet.gain.value = 0;
  const delayNode = ctx.createDelay(5.0); delayNode.delayTime.value = 0.35;
  const delayFeedback = ctx.createGain(); delayFeedback.gain.value = 0.3;
  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = 'lowpass'; delayFilter.frequency.value = 3000;
  const delayMerge = ctx.createGain();

  // Master
  const masterGain = ctx.createGain(); masterGain.gain.value = 1.0;

  // Intercept
  try { output._worklet.disconnect(ctx.destination); } catch (e) {}
  try { output._worklet.disconnect(); } catch (e) {}

  // Wire: worklet -> EQ -> Compressor -> Distortion -> Reverb -> Delay -> Master -> dest
  output._worklet.connect(eqLow);
  eqLow.connect(eqMid); eqMid.connect(eqHigh);
  eqHigh.connect(compDry); eqHigh.connect(compressor);
  compressor.connect(compWet); compDry.connect(compMerge); compWet.connect(compMerge);
  compMerge.connect(distDry); compMerge.connect(distShaper);
  distShaper.connect(distWet); distDry.connect(distMerge); distWet.connect(distMerge);
  distMerge.connect(reverbDry); distMerge.connect(convolver);
  convolver.connect(reverbWet); reverbDry.connect(reverbMerge); reverbWet.connect(reverbMerge);
  reverbMerge.connect(delayDry); reverbMerge.connect(delayNode);
  delayNode.connect(delayFilter); delayFilter.connect(delayFeedback);
  delayFeedback.connect(delayNode); delayFilter.connect(delayWet);
  delayDry.connect(delayMerge); delayWet.connect(delayMerge);
  delayMerge.connect(masterGain); masterGain.connect(ctx.destination);

  FX.nodes = {
    eqLow, eqMid, eqHigh,
    compressor, compDry, compWet, compMerge,
    distShaper, distDry, distWet, distMerge,
    convolver, reverbDry, reverbWet, reverbMerge,
    delayNode, delayFeedback, delayFilter, delayDry, delayWet, delayMerge,
    masterGain
  };
  FX.connected = true;

  // Load saved FX settings
  loadAllTrackFx();
  applyTrackFx(FX.activeTrack);
}

// ── Apply a track's FX state to the audio chain ──
function applyTrackFx(trackIndex) {
  if (!FX.connected) return;
  FX.activeTrack = trackIndex;
  const s = getTrackFxState(trackIndex);
  const t = FX.ctx.currentTime;
  const r = 0.01;

  FX.nodes.eqLow.gain.setTargetAtTime(s.eq.low, t, r);
  FX.nodes.eqMid.gain.setTargetAtTime(s.eq.mid, t, r);
  FX.nodes.eqHigh.gain.setTargetAtTime(s.eq.high, t, r);

  FX.nodes.compWet.gain.setTargetAtTime(s.compressor.on ? 1 : 0, t, r);
  FX.nodes.compDry.gain.setTargetAtTime(s.compressor.on ? 0 : 1, t, r);
  FX.nodes.compressor.threshold.setTargetAtTime(s.compressor.threshold, t, r);
  FX.nodes.compressor.ratio.setTargetAtTime(s.compressor.ratio, t, r);
  FX.nodes.compressor.attack.setTargetAtTime(s.compressor.attack, t, r);
  FX.nodes.compressor.release.setTargetAtTime(s.compressor.release, t, r);

  FX.nodes.distWet.gain.setTargetAtTime(s.distortion.mix, t, r);
  FX.nodes.distDry.gain.setTargetAtTime(1 - s.distortion.mix, t, r);
  FX.nodes.distShaper.curve = makeDistortionCurve(s.distortion.gain);

  FX.nodes.reverbWet.gain.setTargetAtTime(s.reverb.mix, t, r);
  FX.nodes.reverbDry.gain.setTargetAtTime(1 - s.reverb.mix * 0.5, t, r);
  FX.nodes.convolver.buffer = generateImpulseResponse(FX.ctx, s.reverb.decay);

  FX.nodes.delayWet.gain.setTargetAtTime(s.delay.mix, t, r);
  FX.nodes.delayDry.gain.setTargetAtTime(1 - s.delay.mix * 0.5, t, r);
  FX.nodes.delayNode.delayTime.setTargetAtTime(s.delay.time, t, r);
  FX.nodes.delayFeedback.gain.setTargetAtTime(Math.min(s.delay.feedback, 0.9), t, r);

  FX.nodes.masterGain.gain.setTargetAtTime(s.master, t, r);

  // Update UI if panel is visible
  syncTrackFxUI(trackIndex);
}

// ── Per-track setters (modify state + apply to chain) ──
function setTrackFxParam(trackIndex, path, value) {
  const s = getTrackFxState(trackIndex);
  const parts = path.split('.');
  let obj = s;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = value;

  // If this is the active track, apply immediately
  if (trackIndex === FX.activeTrack && FX.connected) {
    applyTrackFx(trackIndex);
  }
  saveAllTrackFx();
}

// ── Distortion curve generator ──
function makeDistortionCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ── Impulse response generator for reverb ──
function generateImpulseResponse(ctx, decay) {
  const rate = ctx.sampleRate;
  const length = rate * Math.max(decay, 0.5);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay * 1.2);
    }
  }
  return impulse;
}

// ── Persistence ──
function saveAllTrackFx() {
  localStorage.setItem('am_fx_tracks', JSON.stringify(FX.trackStates));
}

function loadAllTrackFx() {
  const saved = JSON.parse(localStorage.getItem('am_fx_tracks'));
  if (saved) {
    for (const key of Object.keys(saved)) {
      FX.trackStates[key] = saved[key];
    }
  }
}

// ── Render FX controls inside a mixer track ──
function renderTrackFxPanel(trackIndex, container) {
  const s = getTrackFxState(trackIndex);
  const pre = `fx-t${trackIndex}`;

  container.innerHTML = `
    <div class="fx-section">
      <div class="fx-section-header"><span class="fx-section-title">Master</span></div>
      <div class="fx-row">
        <label>Volume</label>
        <input type="range" class="fx-slider" data-fx="${pre}-master" min="0" max="2" step="0.01" value="${s.master}">
        <span class="fx-value" data-fxv="${pre}-master">${Math.round(s.master * 100)}%</span>
      </div>
    </div>

    <div class="fx-section">
      <div class="fx-section-header"><span class="fx-section-title">EQ</span></div>
      <div class="fx-row">
        <label>Bass</label>
        <input type="range" class="fx-slider" data-fx="${pre}-eq-low" min="-12" max="12" step="0.5" value="${s.eq.low}">
        <span class="fx-value" data-fxv="${pre}-eq-low">${s.eq.low > 0 ? '+' : ''}${s.eq.low} dB</span>
      </div>
      <div class="fx-row">
        <label>Mid</label>
        <input type="range" class="fx-slider" data-fx="${pre}-eq-mid" min="-12" max="12" step="0.5" value="${s.eq.mid}">
        <span class="fx-value" data-fxv="${pre}-eq-mid">${s.eq.mid > 0 ? '+' : ''}${s.eq.mid} dB</span>
      </div>
      <div class="fx-row">
        <label>Treble</label>
        <input type="range" class="fx-slider" data-fx="${pre}-eq-high" min="-12" max="12" step="0.5" value="${s.eq.high}">
        <span class="fx-value" data-fxv="${pre}-eq-high">${s.eq.high > 0 ? '+' : ''}${s.eq.high} dB</span>
      </div>
    </div>

    <div class="fx-section">
      <div class="fx-section-header">
        <span class="fx-section-title">Compressor</span>
        <button class="fx-toggle ${s.compressor.on ? 'is-on' : ''}" data-fx="${pre}-comp-toggle">${s.compressor.on ? 'ON' : 'OFF'}</button>
      </div>
      <div class="fx-row">
        <label>Threshold</label>
        <input type="range" class="fx-slider" data-fx="${pre}-comp-thresh" min="-60" max="0" step="1" value="${s.compressor.threshold}">
        <span class="fx-value" data-fxv="${pre}-comp-thresh">${s.compressor.threshold} dB</span>
      </div>
      <div class="fx-row">
        <label>Ratio</label>
        <input type="range" class="fx-slider" data-fx="${pre}-comp-ratio" min="1" max="20" step="0.5" value="${s.compressor.ratio}">
        <span class="fx-value" data-fxv="${pre}-comp-ratio">${s.compressor.ratio}:1</span>
      </div>
    </div>

    <div class="fx-section">
      <div class="fx-section-header"><span class="fx-section-title">Distortion</span></div>
      <div class="fx-row">
        <label>Mix</label>
        <input type="range" class="fx-slider" data-fx="${pre}-dist-mix" min="0" max="1" step="0.01" value="${s.distortion.mix}">
        <span class="fx-value" data-fxv="${pre}-dist-mix">${Math.round(s.distortion.mix * 100)}%</span>
      </div>
      <div class="fx-row">
        <label>Drive</label>
        <input type="range" class="fx-slider" data-fx="${pre}-dist-gain" min="1" max="200" step="1" value="${s.distortion.gain}">
        <span class="fx-value" data-fxv="${pre}-dist-gain">${s.distortion.gain}</span>
      </div>
    </div>

    <div class="fx-section">
      <div class="fx-section-header"><span class="fx-section-title">Reverb</span></div>
      <div class="fx-row">
        <label>Mix</label>
        <input type="range" class="fx-slider" data-fx="${pre}-rev-mix" min="0" max="1" step="0.01" value="${s.reverb.mix}">
        <span class="fx-value" data-fxv="${pre}-rev-mix">${Math.round(s.reverb.mix * 100)}%</span>
      </div>
      <div class="fx-row">
        <label>Decay</label>
        <input type="range" class="fx-slider" data-fx="${pre}-rev-decay" min="0.5" max="6" step="0.1" value="${s.reverb.decay}">
        <span class="fx-value" data-fxv="${pre}-rev-decay">${s.reverb.decay}s</span>
      </div>
    </div>

    <div class="fx-section">
      <div class="fx-section-header"><span class="fx-section-title">Delay</span></div>
      <div class="fx-row">
        <label>Mix</label>
        <input type="range" class="fx-slider" data-fx="${pre}-del-mix" min="0" max="1" step="0.01" value="${s.delay.mix}">
        <span class="fx-value" data-fxv="${pre}-del-mix">${Math.round(s.delay.mix * 100)}%</span>
      </div>
      <div class="fx-row">
        <label>Time</label>
        <input type="range" class="fx-slider" data-fx="${pre}-del-time" min="0.05" max="2" step="0.01" value="${s.delay.time}">
        <span class="fx-value" data-fxv="${pre}-del-time">${Math.round(s.delay.time * 1000)}ms</span>
      </div>
      <div class="fx-row">
        <label>Feedback</label>
        <input type="range" class="fx-slider" data-fx="${pre}-del-fb" min="0" max="0.9" step="0.01" value="${s.delay.feedback}">
        <span class="fx-value" data-fxv="${pre}-del-fb">${Math.round(s.delay.feedback * 100)}%</span>
      </div>
    </div>

    <div class="fx-section" style="border:none;padding-bottom:0">
      <button class="fx-reset-btn" data-fx="${pre}-reset">Reset FX</button>
    </div>
  `;

  // Bind all sliders
  const idx = trackIndex;
  const bind = (suffix, path, fmt) => {
    const el = container.querySelector(`[data-fx="${pre}-${suffix}"]`);
    const valEl = container.querySelector(`[data-fxv="${pre}-${suffix}"]`);
    if (!el) return;
    el.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      setTrackFxParam(idx, path, v);
      if (valEl) valEl.textContent = fmt(v);
    });
  };

  bind('master', 'master', v => Math.round(v * 100) + '%');
  bind('eq-low', 'eq.low', v => (v > 0 ? '+' : '') + v + ' dB');
  bind('eq-mid', 'eq.mid', v => (v > 0 ? '+' : '') + v + ' dB');
  bind('eq-high', 'eq.high', v => (v > 0 ? '+' : '') + v + ' dB');
  bind('comp-thresh', 'compressor.threshold', v => v + ' dB');
  bind('comp-ratio', 'compressor.ratio', v => v + ':1');
  bind('dist-mix', 'distortion.mix', v => Math.round(v * 100) + '%');
  bind('dist-gain', 'distortion.gain', v => Math.round(v));
  bind('rev-mix', 'reverb.mix', v => Math.round(v * 100) + '%');
  bind('rev-decay', 'reverb.decay', v => v.toFixed(1) + 's');
  bind('del-mix', 'delay.mix', v => Math.round(v * 100) + '%');
  bind('del-time', 'delay.time', v => Math.round(v * 1000) + 'ms');
  bind('del-fb', 'delay.feedback', v => Math.round(v * 100) + '%');

  // Compressor toggle
  const compToggle = container.querySelector(`[data-fx="${pre}-comp-toggle"]`);
  if (compToggle) {
    compToggle.addEventListener('click', () => {
      const on = !getTrackFxState(idx).compressor.on;
      setTrackFxParam(idx, 'compressor.on', on);
      compToggle.classList.toggle('is-on', on);
      compToggle.textContent = on ? 'ON' : 'OFF';
    });
  }

  // Reset
  const resetBtn = container.querySelector(`[data-fx="${pre}-reset"]`);
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      FX.trackStates[idx] = defaultFxState();
      applyTrackFx(idx);
      renderTrackFxPanel(idx, container);
      saveAllTrackFx();
    });
  }
}

// ── Sync UI if panel is open ──
function syncTrackFxUI(trackIndex) {
  const pre = `fx-t${trackIndex}`;
  const s = getTrackFxState(trackIndex);

  const setV = (suffix, val) => {
    const el = document.querySelector(`[data-fx="${pre}-${suffix}"]`);
    if (el && el.tagName === 'INPUT') el.value = val;
  };
  const setT = (suffix, text) => {
    const el = document.querySelector(`[data-fxv="${pre}-${suffix}"]`);
    if (el) el.textContent = text;
  };

  setV('master', s.master); setT('master', Math.round(s.master * 100) + '%');
  setV('eq-low', s.eq.low); setT('eq-low', (s.eq.low > 0 ? '+' : '') + s.eq.low + ' dB');
  setV('eq-mid', s.eq.mid); setT('eq-mid', (s.eq.mid > 0 ? '+' : '') + s.eq.mid + ' dB');
  setV('eq-high', s.eq.high); setT('eq-high', (s.eq.high > 0 ? '+' : '') + s.eq.high + ' dB');
  setV('comp-thresh', s.compressor.threshold); setT('comp-thresh', s.compressor.threshold + ' dB');
  setV('comp-ratio', s.compressor.ratio); setT('comp-ratio', s.compressor.ratio + ':1');
  setV('dist-mix', s.distortion.mix); setT('dist-mix', Math.round(s.distortion.mix * 100) + '%');
  setV('dist-gain', s.distortion.gain); setT('dist-gain', Math.round(s.distortion.gain));
  setV('rev-mix', s.reverb.mix); setT('rev-mix', Math.round(s.reverb.mix * 100) + '%');
  setV('rev-decay', s.reverb.decay); setT('rev-decay', s.reverb.decay.toFixed(1) + 's');
  setV('del-mix', s.delay.mix); setT('del-mix', Math.round(s.delay.mix * 100) + '%');
  setV('del-time', s.delay.time); setT('del-time', Math.round(s.delay.time * 1000) + 'ms');
  setV('del-fb', s.delay.feedback); setT('del-fb', Math.round(s.delay.feedback * 100) + '%');
}
