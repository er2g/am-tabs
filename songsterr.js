// ─── Songsterr Search & Import (Hero Rail) ───
const SS_API = 'http://localhost:3131';

const ss = {
  downloading: false,
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── Bind UI events ──
function initSongsterrUI() {
  const heroInput = document.getElementById('hero-search-input');
  const heroBtn = document.getElementById('hero-search-btn');

  heroBtn.addEventListener('click', () => heroSearch(heroInput.value));
  heroInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') heroSearch(heroInput.value);
  });
}

// ── Hero inline search ──
async function heroSearch(query) {
  if (!query.trim()) return;

  const resultsEl = document.getElementById('hero-search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="hero-sr-status">Aranıyor...</div>';

  try {
    const resp = await fetch(`${SS_API}/search?q=${encodeURIComponent(query)}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    resultsEl.innerHTML = '';

    if (data.length === 0) {
      resultsEl.innerHTML = '<div class="hero-sr-status">Sonuç bulunamadı</div>';
      return;
    }

    data.slice(0, 8).forEach(song => {
      const item = document.createElement('div');
      item.className = 'hero-sr-item';
      item.innerHTML = `
        <div class="hero-sr-info">
          <div class="hero-sr-title">${escapeHtml(song.title)}</div>
          <div class="hero-sr-artist">${escapeHtml(song.artist)}</div>
        </div>
        <button class="hero-sr-dl" title="İndir ve Yükle">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
      `;

      const dlBtn = item.querySelector('.hero-sr-dl');
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        heroDownload(song.songId, song.title, song.artist, dlBtn, song);
      });

      resultsEl.appendChild(item);
    });
  } catch (e) {
    resultsEl.innerHTML = `<div class="hero-sr-status">Hata: ${e.message}</div>`;
  }
}

// ── Download & load ──
async function heroDownload(songId, title, artist, btn, song) {
  if (ss.downloading) return;
  ss.downloading = true;

  const origHTML = btn.innerHTML;
  btn.innerHTML = '<div class="ss-spinner"></div>';
  btn.disabled = true;

  try {
    const resp = await fetch(`${SS_API}/download/${songId}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'İndirme başarısız' }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const blob = await resp.blob();
    const fileName = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1]
      || `${artist}-${title}.gp`;
    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    // Save to DB
    try {
      const dbId = await dbSaveSong({
        title, artist, fileName,
        tracks: song ? song.tracks : [],
        fileData: uint8,
      });
      window._activeSongDbId = dbId;
    } catch (dbErr) {
      console.warn('[db] Save failed:', dbErr);
    }

    api.load(uint8);
    if (typeof renderLibrary === 'function') renderLibrary();

    // Clear search results
    document.getElementById('hero-search-results').classList.add('hidden');
    document.getElementById('hero-search-input').value = '';
  } catch (e) {
    alert('Hata: ' + e.message);
  } finally {
    ss.downloading = false;
    btn.innerHTML = origHTML;
    btn.disabled = false;
  }
}

// Auto-init when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSongsterrUI);
} else {
  initSongsterrUI();
}
