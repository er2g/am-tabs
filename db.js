// ─── AM Tabs IndexedDB Song Library ───
const DB_NAME = 'am_tabs';
const DB_VERSION = 1;
const STORE_NAME = 'songs';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('title', 'title', { unique: false });
        store.createIndex('artist', 'artist', { unique: false });
        store.createIndex('addedAt', 'addedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// Save a song (fileData = Uint8Array)
async function dbSaveSong({ title, artist, fileName, tracks, fileData }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = {
      title: title || 'Unknown',
      artist: artist || 'Unknown',
      fileName: fileName || 'unknown.gp',
      trackCount: tracks ? tracks.length : 0,
      tracks: tracks || [],
      fileData: fileData,
      prefs: {},
      addedAt: Date.now(),
    };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result); // returns id
    req.onerror = (e) => reject(e.target.error);
    tx.onerror = (e) => reject(e.target.error);
  });
}

// Get all songs (without fileData for listing)
async function dbGetAllSongs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const songs = req.result.map(s => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        fileName: s.fileName,
        trackCount: s.trackCount,
        tracks: s.tracks,
        addedAt: s.addedAt,
      }));
      // Sort newest first
      songs.sort((a, b) => b.addedAt - a.addedAt);
      resolve(songs);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// Get a song with fileData
async function dbGetSong(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// Delete a song
async function dbDeleteSong(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// Save track preferences for a song
async function dbSaveTrackPrefs(id, trackIndex, newPrefs) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return reject(new Error('Song not found'));
      if (!record.prefs) record.prefs = {};
      if (!record.prefs[trackIndex]) record.prefs[trackIndex] = {};
      Object.assign(record.prefs[trackIndex], newPrefs);
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

// Get track preferences for a song
async function dbGetTrackPrefs(id) {
  const song = await dbGetSong(id);
  return song ? (song.prefs || {}) : {};
}
