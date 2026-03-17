const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

const state = {
  playing: false,
  speed: 1,
  metronome: true,
  autoscroll: true,
  source: "original",
  duration: 0,
  currentTime: 0,
  pitch: 0,
  looping: false
};

let api = null;

document.addEventListener("DOMContentLoaded", () => {
  initAlphaTab();
  bindControls();
});

function initAlphaTab() {
  const tablature = document.getElementById("tablature");
  
  api = new alphaTab.AlphaTabApi(tablature, {
    core: {
      logLevel: 'info',
      engine: 'svg'
    },
    display: {
      layoutMode: 'page', // or 'horizontal'
      // We remove strict 'Tab' profile from global settings 
      // so it can dynamically switch for Drums vs Guitar
    },
    notation: {
      rhythmMode: 'ShowWithBeams'
    },
    player: {
      enablePlayer: true,
      soundFont: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/soundfont/sonivox.sf2',
      scrollElement: document.documentElement,
      scrollMode: 1, // Continuous scroll
      scrollOffsetY: -120 // Offset for the fixed bottom control bar
    },
    // Using a sample GP file since we don't have a local one
    file: 'https://www.alphatab.net/files/canon.gp'
  });

  api.scoreLoaded.on(score => {
    document.querySelector('.hero-copy h1').innerHTML = `${score.title} <span>Tab</span>`;
    document.querySelector('.hero-meta a').textContent = score.artist || "Unknown Artist";
    
    // Load saved preferences for this song
    const songId = score.title || "UnknownSong";
    const savedPrefs = JSON.parse(localStorage.getItem(`am_tabs_${songId}`)) || {};
    
    // Apply saved programs
    score.tracks.forEach((track, index) => {
      if (savedPrefs[index] !== undefined && !track.isPercussion) {
        track.playbackInfo.program = savedPrefs[index];
      }
    });
    
    // Setup tracks dropdown
    const trackSelect = document.getElementById('track-select');
    const instrumentSelect = document.getElementById('instrument-select');
    
    if (score.tracks.length > 0) {
      trackSelect.innerHTML = ''; // Clear loading
      
      score.tracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = track.name;
        trackSelect.appendChild(option);
      });

      // Listen for track changes
      trackSelect.addEventListener('change', (e) => {
        const selectedIndex = parseInt(e.target.value, 10);
        const selectedTrack = score.tracks[selectedIndex];

        // Ensure we display tabs for guitars, but standard notation for drums
        api.settings.display.staveProfile = selectedTrack.isPercussion ? 'Score' : 'Tab';
        api.updateSettings();

        // Update instrument select UI
        instrumentSelect.value = selectedTrack.playbackInfo.program;
        instrumentSelect.disabled = selectedTrack.isPercussion; // Disable changing drums for simplicity

        api.renderTracks([selectedTrack]); // Render the new track
      });
      
      // Initialize first track correctly
      const firstTrack = score.tracks[0];
      api.settings.display.staveProfile = firstTrack.isPercussion ? 'Score' : 'Tab';
      api.updateSettings();
      api.renderTracks([firstTrack]);
      
      // Init UI
      instrumentSelect.value = firstTrack.playbackInfo.program;
      instrumentSelect.disabled = firstTrack.isPercussion;
    }
  });

  api.playerReady.on(() => {
    // Player is ready
    updateTimeDisplay();
  });

  api.playerPositionChanged.on((e) => {
    state.currentTime = e.currentTime;
    state.duration = e.endTime;
    
    // Update Slider
    const slider = document.getElementById("measure-slider");
    if (slider.dataset.isDragging !== "true") {
      slider.max = state.duration;
      slider.value = state.currentTime;
    }
    
    // Update Readout
    updateTimeDisplay();
    
    // Update Measure Readout if available
    if (e.currentTick) {
       // Tick info can be used to roughly estimate measure if we parse the score details, 
       // but for simplicity we'll just show time.
    }
  });

  let selectionStart = null;
  let isDragging = false;

  api.beatMouseDown.on((beat) => {
    isDragging = true;
    selectionStart = beat;
    api.highlightPlaybackRange(beat, beat);
  });

  api.beatMouseMove.on((beat) => {
    if (isDragging && selectionStart) {
      api.highlightPlaybackRange(selectionStart, beat);
    }
  });

  api.beatMouseUp.on(() => {
    if (isDragging && selectionStart) {
      api.applyPlaybackRangeFromHighlight();
      isDragging = false;
      selectionStart = null;
    }
  });

  // To prevent the selection getting stuck when the mouse leaves the container during drag
  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      selectionStart = null;
      // We don't apply the range if they let go outside the notation
    }
  });

  api.playerStateChanged.on((e) => {
    // 0 = stopped, 1 = playing, 2 = paused
    state.playing = (e.state === 1);
    
    document.getElementById("root").dataset.playing = state.playing ? "on" : "off";
    document.getElementById("control-play").setAttribute("aria-pressed", String(state.playing));
    
    const playButton = document.getElementById("control-play");
    if (state.playing) {
      playButton.classList.add('is-playing');
    } else {
      playButton.classList.remove('is-playing');
    }
  });
}

function bindControls() {
  const playButton = document.getElementById("control-play");
  const speedButton = document.getElementById("control-speed");
  const pitchButton = document.getElementById("control-pitch");
  const loopButton = document.getElementById("control-loop");
  const slider = document.getElementById("measure-slider");
  const metronome = document.getElementById("control-metronome");
  const autoscrollButton = document.getElementById("control-autoscroll");
  
  // Track settings UI
  const trackSettingsBtn = document.getElementById("track-settings-btn");
  const trackSettingsPanel = document.getElementById("track-settings-panel");
  const instrumentSelect = document.getElementById("instrument-select");

  trackSettingsBtn.addEventListener("click", () => {
    trackSettingsPanel.classList.toggle("hidden");
  });

  // Close panel if clicked outside
  document.addEventListener("click", (e) => {
    if (!trackSettingsBtn.contains(e.target) && !trackSettingsPanel.contains(e.target)) {
      trackSettingsPanel.classList.add("hidden");
    }
  });

  instrumentSelect.addEventListener("change", (e) => {
    if (!api || !api.score) return;
    const trackSelect = document.getElementById('track-select');
    const selectedIndex = parseInt(trackSelect.value, 10);
    const selectedTrack = api.score.tracks[selectedIndex];
    
    if (selectedTrack && !selectedTrack.isPercussion) {
      const newProgram = parseInt(e.target.value, 10);
      selectedTrack.playbackInfo.program = newProgram;
      api.loadMidiForScore(); // Apply the sound change
      
      // Save to localStorage
      const songId = api.score.title || "UnknownSong";
      const storageKey = `am_tabs_${songId}`;
      const savedPrefs = JSON.parse(localStorage.getItem(storageKey)) || {};
      savedPrefs[selectedIndex] = newProgram;
      localStorage.setItem(storageKey, JSON.stringify(savedPrefs));
    }
  });

  playButton.addEventListener("click", () => {
    if (!api) return;
    api.playPause();
  });

  autoscrollButton.addEventListener("click", () => {
    if (!api) return;
    state.autoscroll = !state.autoscroll;
    
    // 1 = Continuous, 0 = Off
    api.settings.player.scrollMode = state.autoscroll ? 1 : 0;
    api.updateSettings();

    autoscrollButton.setAttribute("aria-pressed", String(state.autoscroll));
    document.getElementById("autoscroll-readout").textContent = state.autoscroll ? "On" : "Off";
  });

  speedButton.addEventListener("click", () => {
    if (!api) return;
    const currentIndex = SPEED_STEPS.indexOf(state.speed);
    const nextIndex = (currentIndex + 1) % SPEED_STEPS.length;
    state.speed = SPEED_STEPS[nextIndex];
    api.playbackSpeed = state.speed;
    document.getElementById("speed-readout").textContent = `${Math.round(state.speed * 100)}%`;
  });

  pitchButton.addEventListener("click", () => {
    if (!api || !api.score) return;
    // Semitone steps for tuning
    const PITCH_STEPS = [0, 1, 2, 3, -3, -2, -1];
    const currentIndex = PITCH_STEPS.indexOf(state.pitch);
    const nextIndex = (currentIndex + 1) % PITCH_STEPS.length;
    state.pitch = PITCH_STEPS[nextIndex];
    
    // Change pitch for all tracks dynamically
    api.changeTrackTranspositionPitch(api.score.tracks, state.pitch);
    
    const pitchText = state.pitch > 0 ? `+${state.pitch}` : String(state.pitch);
    document.getElementById("pitch-readout").textContent = pitchText;
  });

  loopButton.addEventListener("click", () => {
    if (!api) return;
    state.looping = !state.looping;
    api.isLooping = state.looping;
    
    loopButton.setAttribute("aria-pressed", String(state.looping));
    document.getElementById("loop-readout").textContent = state.looping ? "On" : "Off";
  });

  // Setup slider max/min
  slider.min = 0;
  slider.step = 100; // ms step

  slider.addEventListener("mousedown", () => {
    slider.dataset.isDragging = "true";
  });

  slider.addEventListener("mouseup", (event) => {
    slider.dataset.isDragging = "false";
    if (!api) return;
    api.timePosition = Number(event.target.value);
  });
  
  slider.addEventListener("input", (event) => {
    // Visual update while dragging
    state.currentTime = Number(event.target.value);
    updateTimeDisplay();
  });

  metronome.addEventListener("click", () => {
    if (!api) return;
    state.metronome = !state.metronome;
    api.metronomeVolume = state.metronome ? 1 : 0;
    metronome.setAttribute("aria-pressed", String(state.metronome));
    metronome.querySelector("strong").textContent = state.metronome ? "On" : "Off";
  });

  // Hotkeys
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;

    if (event.code === "Space") {
      event.preventDefault();
      if (api) api.playPause();
    }
  });
}

function updateTimeDisplay() {
  document.getElementById("time-readout").textContent = 
    `${formatTime(state.currentTime / 1000)} / ${formatTime(state.duration / 1000)}`;
}

function formatTime(totalSeconds) {
  if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
