const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

const state = {
  playing: false,
  speed: 1,
  metronome: true,
  autoscroll: true,
  source: "original",
  duration: 0,
  currentTime: 0,
  looping: true,
  activeTrackIndex: 0
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

  api.scoreLoaded.on(async (score) => {
    document.querySelector('.hero-copy h1').innerHTML = `${score.title} <span>Tab</span>`;
    document.querySelector('.hero-meta a').textContent = score.artist || "Unknown Artist";

    // Load saved preferences - try DB first, fallback to localStorage
    let savedPrefs = {};
    const dbId = window._activeSongDbId;
    if (dbId) {
      try {
        savedPrefs = await dbGetTrackPrefs(dbId);
      } catch (e) {
        console.warn('[db] Failed to load prefs:', e);
      }
    }
    if (Object.keys(savedPrefs).length === 0) {
      const lsKey = score.title || "UnknownSong";
      savedPrefs = JSON.parse(localStorage.getItem(`am_tabs_${lsKey}`)) || {};
    }

    // Apply saved programs & volumes
    score.tracks.forEach((track, index) => {
      const prefs = savedPrefs[index] || {};
      if (prefs.program !== undefined && !track.isPercussion) {
        track.playbackInfo.program = prefs.program;
        for (const staff of track.staves) {
          for (const bar of staff.bars) {
            for (const voice of bar.voices) {
              for (const beat of voice.beats) {
                for (const auto of beat.automations) {
                  if (auto.type === 2) auto.value = prefs.program;
                }
              }
            }
          }
        }
      }
      if (prefs.volume !== undefined) track.playbackInfo.volume = prefs.volume;
      if (prefs.isMute !== undefined) track.playbackInfo.isMute = prefs.isMute;
      if (prefs.isSolo !== undefined) track.playbackInfo.isSolo = prefs.isSolo;
    });

    api.loadMidiForScore();
    renderMixerTracks(score);

    // Update DB record with actual track info from score
    if (dbId && typeof dbGetSong === 'function') {
      dbGetSong(dbId).then(record => {
        if (record && (!record.tracks || record.tracks.length === 0)) {
          record.title = score.title || record.title;
          record.artist = score.artist || record.artist;
          record.trackCount = score.tracks.length;
          record.tracks = score.tracks.map(t => ({
            name: t.name,
            instrument: t.isPercussion ? 'Drums' : t.playbackInfo.program,
          }));
          openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(record);
          });
        }
      }).catch(() => {});
    }

    if (score.tracks.length > 0) {
      selectTrack(0);
    }
  });

  api.playerReady.on(() => {
    updateTimeDisplay();
    // Apply initial metronome and loop state
    api.metronomeVolume = state.metronome ? 1 : 0;
    api.isLooping = state.looping;
    // Initialize audio effects chain once player is ready
    initEffects();
  });

  api.playerPositionChanged.on((e) => {
    state.currentTime = e.currentTime;
    state.duration = e.endTime;
    
    const slider = document.getElementById("measure-slider");
    if (slider.dataset.isDragging !== "true") {
      slider.max = state.duration;
      slider.value = state.currentTime;
    }
    
    updateTimeDisplay();
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

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      selectionStart = null;
    }
  });

  api.playerStateChanged.on((e) => {
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

function selectTrack(index) {
  if (!api || !api.score) return;
  state.activeTrackIndex = index;
  const selectedTrack = api.score.tracks[index];

  // Update UI Name
  document.getElementById("current-track-name").textContent = selectedTrack.name;

  // Render
  api.settings.display.staveProfile = selectedTrack.isPercussion ? 'Score' : 'Tab';
  api.updateSettings();
  api.renderTracks([selectedTrack]);

  // Update Mixer Modal UI highlights
  document.querySelectorAll(".mixer-track-item").forEach(item => {
    item.classList.toggle("is-active", parseInt(item.dataset.index) === index);
  });

  // Apply this track's FX settings
  if (typeof applyTrackFx === 'function') applyTrackFx(index);
}

function renderMixerTracks(score) {
  const container = document.getElementById("mixer-track-list");
  container.innerHTML = "";

  score.tracks.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "mixer-track-item";
    item.dataset.index = index;

    // Track Info (clickable to select/view)
    const info = document.createElement("div");
    info.className = "mixer-track-info";
    info.innerHTML = `
      <div class="mixer-track-name">${track.name}</div>
      <div class="mixer-track-instrument">${track.isPercussion ? 'Drums' : 'Instrument ' + track.playbackInfo.program}</div>
    `;
    info.addEventListener("click", () => selectTrack(index));

    // Controls
    const controls = document.createElement("div");
    controls.className = "mixer-controls";

    // Instrument Dropdown (only for non-percussion)
    if (!track.isPercussion) {
      const select = document.createElement("select");
      select.className = "mixer-prog-select";
      const options = [
        {val: 24, label: 'Acoustic Guitar'},
        {val: 25, label: 'Acoustic (Steel)'},
        {val: 27, label: 'Electric (Clean)'},
        {val: 29, label: 'Overdrive'},
        {val: 30, label: 'Distortion'},
        {val: 33, label: 'Electric Bass'},
        {val: 0, label: 'Piano'},
        {val: 48, label: 'Strings'}
      ];
      // ensure current program is in the list
      if (!options.find(o => o.val === track.playbackInfo.program)) {
        options.push({val: track.playbackInfo.program, label: 'Custom (' + track.playbackInfo.program + ')'});
      }
      
      options.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.val;
        o.textContent = opt.label;
        if (opt.val === track.playbackInfo.program) o.selected = true;
        select.appendChild(o);
      });

      select.addEventListener("change", (e) => {
        const newProgram = parseInt(e.target.value, 10);

        // Stop playback first if playing
        const wasPlaying = state.playing;
        if (wasPlaying) {
          api.stop();
        }

        // Update playbackInfo
        track.playbackInfo.program = newProgram;

        // Also update Instrument automations on beats - these override playbackInfo
        // in the MidiFileGenerator, so without this the sound won't actually change
        for (const staff of track.staves) {
          for (const bar of staff.bars) {
            for (const voice of bar.voices) {
              for (const beat of voice.beats) {
                for (const auto of beat.automations) {
                  if (auto.type === 2) { // AutomationType.Instrument
                    auto.value = newProgram;
                  }
                }
              }
            }
          }
        }

        // Reload MIDI with updated program
        api.loadMidiForScore();
        api.render();

        // Restart playback with new instrument
        if (wasPlaying) {
          setTimeout(() => {
            api.play();
          }, 200);
        }

        saveTrackPref(score.title, index, { program: newProgram });
        info.querySelector('.mixer-track-instrument').textContent = 'Instrument ' + newProgram;
      });
      controls.appendChild(select);
    }

    // Solo Btn
    const soloBtn = document.createElement("button");
    soloBtn.className = `mixer-btn ${track.playbackInfo.isSolo ? 'is-active' : ''}`;
    soloBtn.title = "Solo";
    soloBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg>';
    soloBtn.addEventListener("click", () => {
      const isSolo = !track.playbackInfo.isSolo;
      api.changeTrackSolo([track], isSolo);
      soloBtn.classList.toggle("is-active", isSolo);
      saveTrackPref(score.title, index, { isSolo });
    });
    controls.appendChild(soloBtn);

    // Mute Btn
    const muteBtn = document.createElement("button");
    muteBtn.className = `mixer-btn ${track.playbackInfo.isMute ? 'is-active' : ''}`;
    muteBtn.title = "Mute";
    muteBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
    muteBtn.addEventListener("click", () => {
      const isMute = !track.playbackInfo.isMute;
      api.changeTrackMute([track], isMute);
      muteBtn.classList.toggle("is-active", isMute);
      saveTrackPref(score.title, index, { isMute });
    });
    controls.appendChild(muteBtn);

    // Volume Slider
    const volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.className = "mixer-vol";
    volSlider.min = 0;
    volSlider.max = 2; // up to 200%
    volSlider.step = 0.1;
    volSlider.value = track.playbackInfo.volume;
    volSlider.title = "Volume";
    volSlider.addEventListener("input", (e) => {
      const vol = parseFloat(e.target.value);
      api.changeTrackVolume([track], vol);
      saveTrackPref(score.title, index, { volume: vol });
    });
    controls.appendChild(volSlider);

    // FX Toggle Button
    const fxBtn = document.createElement("button");
    fxBtn.className = "mixer-btn mixer-fx-btn";
    fxBtn.title = "Effects";
    fxBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>';

    // FX Panel (hidden by default)
    const fxPanel = document.createElement("div");
    fxPanel.className = "mixer-fx-panel hidden";

    fxBtn.addEventListener("click", () => {
      const isHidden = fxPanel.classList.contains("hidden");
      // Close all other FX panels
      container.querySelectorAll(".mixer-fx-panel").forEach(p => p.classList.add("hidden"));
      container.querySelectorAll(".mixer-fx-btn").forEach(b => b.classList.remove("is-active"));
      if (isHidden) {
        fxPanel.classList.remove("hidden");
        fxBtn.classList.add("is-active");
        renderTrackFxPanel(index, fxPanel);
        applyTrackFx(index);
      }
    });
    controls.appendChild(fxBtn);

    item.appendChild(info);
    item.appendChild(controls);
    item.appendChild(fxPanel);
    container.appendChild(item);
  });
}

function saveTrackPref(songTitle, index, newPrefs) {
  // Save to DB if active song has a DB ID
  const dbId = window._activeSongDbId;
  if (dbId) {
    dbSaveTrackPrefs(dbId, index, newPrefs).catch(e =>
      console.warn('[db] Failed to save pref:', e)
    );
  }
  // Also keep localStorage as fallback
  const songId = songTitle || "UnknownSong";
  const storageKey = `am_tabs_${songId}`;
  const savedPrefs = JSON.parse(localStorage.getItem(storageKey)) || {};
  if (!savedPrefs[index]) savedPrefs[index] = {};
  Object.assign(savedPrefs[index], newPrefs);
  localStorage.setItem(storageKey, JSON.stringify(savedPrefs));
}

function bindControls() {
  const playButton = document.getElementById("control-play");
  const speedButton = document.getElementById("control-speed");
  const loopButton = document.getElementById("control-loop");
  const slider = document.getElementById("measure-slider");
  const metronome = document.getElementById("control-metronome");
  const autoscrollButton = document.getElementById("control-autoscroll");
  
  // Mixer Overlay logic
  const openMixerBtn = document.getElementById("open-mixer-btn");
  const closeMixerBtn = document.getElementById("close-mixer-btn");
  const mixerOverlay = document.getElementById("mixer-overlay");

  openMixerBtn.addEventListener("click", () => {
    mixerOverlay.classList.remove("hidden");
  });

  closeMixerBtn.addEventListener("click", () => {
    mixerOverlay.classList.add("hidden");
  });

  mixerOverlay.addEventListener("click", (e) => {
    if (e.target === mixerOverlay) {
      mixerOverlay.classList.add("hidden");
    }
  });

  playButton.addEventListener("click", () => {
    if (!api) return;
    api.playPause();
  });

  autoscrollButton.addEventListener("click", () => {
    if (!api) return;
    state.autoscroll = !state.autoscroll;
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

  // Pitch shift removed - not supported by AlphaTab API

  loopButton.addEventListener("click", () => {
    if (!api) return;
    state.looping = !state.looping;
    api.isLooping = state.looping;
    loopButton.setAttribute("aria-pressed", String(state.looping));
    document.getElementById("loop-readout").textContent = state.looping ? "On" : "Off";
  });

  slider.min = 0;
  slider.step = 100;

  slider.addEventListener("mousedown", () => {
    slider.dataset.isDragging = "true";
  });

  slider.addEventListener("mouseup", (event) => {
    slider.dataset.isDragging = "false";
    if (!api) return;
    api.timePosition = Number(event.target.value);
  });
  
  slider.addEventListener("input", (event) => {
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
