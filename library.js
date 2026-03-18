// ─── Song Library UI ───

async function renderLibrary() {
  const list = document.getElementById('library-list');
  if (!list) return;

  try {
    const songs = await dbGetAllSongs();
    list.innerHTML = '';

    if (songs.length === 0) {
      list.innerHTML = '<div class="lib-empty">Henüz kayıtlı şarkı yok.<br>Songsterr\'den şarkı indir veya dosya yükle.</div>';
      return;
    }

    songs.forEach(song => {
      const item = document.createElement('div');
      item.className = 'lib-song-item';
      if (window._activeSongDbId === song.id) item.classList.add('is-active');

      const date = new Date(song.addedAt);
      const dateStr = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;

      item.innerHTML = `
        <div class="lib-song-info">
          <div class="lib-song-title">${escapeHtml(song.title)}</div>
          <div class="lib-song-meta">
            <span class="lib-song-artist">${escapeHtml(song.artist)}</span>
            <span class="lib-song-tracks">${song.trackCount} parça</span>
            <span class="lib-song-date">${dateStr}</span>
          </div>
        </div>
        <div class="lib-song-actions">
          <button class="lib-load-btn" title="Yükle">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polygon points="5,3 19,12 5,21"></polygon>
            </svg>
          </button>
          <button class="lib-delete-btn" title="Sil">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
            </svg>
          </button>
        </div>
      `;

      item.querySelector('.lib-load-btn').addEventListener('click', () => loadSongFromDB(song.id));
      item.querySelector('.lib-delete-btn').addEventListener('click', async () => {
        if (!confirm(`"${song.title}" silinsin mi?`)) return;
        await dbDeleteSong(song.id);
        if (window._activeSongDbId === song.id) window._activeSongDbId = null;
        renderLibrary();
      });

      // Double click whole item to load
      item.querySelector('.lib-song-info').addEventListener('click', () => loadSongFromDB(song.id));

      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = `<div class="lib-empty">Veritabanı hatası: ${e.message}</div>`;
  }
}

async function loadSongFromDB(id) {
  try {
    const song = await dbGetSong(id);
    if (!song || !song.fileData) {
      alert('Şarkı verisi bulunamadı!');
      return;
    }

    window._activeSongDbId = id;
    const uint8 = song.fileData instanceof Uint8Array ? song.fileData : new Uint8Array(song.fileData);
    api.load(uint8);

    // Close library
    document.getElementById('library-overlay').classList.add('hidden');

    // Re-highlight
    renderLibrary();
  } catch (e) {
    alert('Yükleme hatası: ' + e.message);
  }
}

// File import (local GP files)
function handleFileImport(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    const uint8 = new Uint8Array(e.target.result);

    // Extract name from filename
    const name = file.name.replace(/\.(gp|gp3|gp4|gp5|gpx|gp8)$/i, '');

    try {
      const dbId = await dbSaveSong({
        title: name,
        artist: 'Unknown',
        fileName: file.name,
        tracks: [],
        fileData: uint8,
      });
      window._activeSongDbId = dbId;
      api.load(uint8);
      renderLibrary();
      document.getElementById('library-overlay').classList.add('hidden');
    } catch (err) {
      alert('Kayıt hatası: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function initLibraryUI() {
  const overlay = document.getElementById('library-overlay');
  const closeBtn = document.getElementById('close-library-btn');
  const importBtn = document.getElementById('lib-import-btn');
  const fileInput = document.getElementById('lib-file-input');

  closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileImport(e.target.files[0]);
      e.target.value = '';
    }
  });

  // Hero action buttons (in header rail)
  const heroLibBtn = document.getElementById('hero-library-btn');
  const heroImportBtn = document.getElementById('hero-import-btn');
  const heroFileInput = document.getElementById('hero-file-input');

  heroLibBtn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    renderLibrary();
  });

  heroImportBtn.addEventListener('click', () => heroFileInput.click());
  heroFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileImport(e.target.files[0]);
      e.target.value = '';
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLibraryUI);
} else {
  initLibraryUI();
}
