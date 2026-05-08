// ============================================================
// SoloPlayer - PWA Music Player
// ============================================================

(function () {
  'use strict';

  // ---- Debug (console only) ----
  function dlog(msg) { console.log('[SoloPlayer]', msg); }

  // ---- Capacitor detection ----
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ---- State ----
  const state = {
    allSongs: [],          // [{ name, file, folder, artUrl, artist, duration, durationStr }]
    autoPlaylists: [],     // [{ name, coverUrl, songs: [] }]
    manualPlaylists: [],   // [{ id, name, songKeys: [] }]
    currentQueue: [],      // song refs in play order
    currentIndex: -1,
    shuffleOn: false,
    repeatMode: 0,         // 0=off, 1=all, 2=one
    playingContext: null,   // { type:'all' } | { type:'auto', name } | { type:'manual', id }
    isPlaying: false,
    currentSong: null,
    folderHandles: new Map(), // folder name -> FileSystemDirectoryHandle
  };

  const audio = new Audio();
  audio.preload = 'metadata';

  // ---- DOM refs ----
  const $ = id => document.getElementById(id);
  const landing = $('landing');
  const app = $('app');
  const btnSelectFolder = $('btnSelectFolder');
  const folderInput = $('folderInput');
  const btnReload = $('btnReload');
  const searchInput = $('searchInput');
  const songListEl = $('songList');
  const autoPlaylistsEl = $('autoPlaylists');
  const manualPlaylistsEl = $('manualPlaylists');
  const btnNewPlaylist = $('btnNewPlaylist');
  const songsTab = $('songsTab');
  const playlistsTab = $('playlistsTab');
  const playlistDetail = $('playlistDetail');
  const miniPlayer = $('miniPlayer');
  const nowPlayingEl = $('nowPlaying');

  // ============================================================
  // ID3 Parser (minimal, for ID3v2 embedded art + artist)
  // ============================================================
  async function parseID3(file) {
    const result = { artist: null, artBlob: null };
    try {
      const buf = await readFileSlice(file, 0, Math.min(file.size, 512 * 1024));
      const view = new DataView(buf);
      if (buf.byteLength < 10) return result;

      // Check ID3v2 header
      const id3 = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
      if (id3 !== 'ID3') return result;

      const majorVer = view.getUint8(3);
      const headerSize = decodeSynchsafe(view, 6);
      let offset = 10;
      const end = 10 + headerSize;

      while (offset + 10 < end && offset + 10 < buf.byteLength) {
        const frameId = String.fromCharCode(
          view.getUint8(offset), view.getUint8(offset + 1),
          view.getUint8(offset + 2), view.getUint8(offset + 3)
        );
        if (frameId.charCodeAt(0) === 0) break;

        let frameSize;
        if (majorVer >= 4) {
          frameSize = decodeSynchsafe(view, offset + 4);
        } else {
          frameSize = view.getUint32(offset + 4);
        }
        if (frameSize <= 0 || offset + 10 + frameSize > buf.byteLength) break;

        const frameData = offset + 10;

        if (frameId === 'TPE1' || frameId === 'TPE2') {
          result.artist = readTextFrame(buf, frameData, frameSize);
        }

        if (frameId === 'APIC') {
          result.artBlob = readAPICFrame(buf, frameData, frameSize);
        }

        offset += 10 + frameSize;
      }
    } catch (e) { /* ignore parse errors */ }
    return result;
  }

  function readFileSlice(file, start, end) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file.slice(start, end));
    });
  }

  function decodeSynchsafe(view, offset) {
    return (view.getUint8(offset) << 21) |
           (view.getUint8(offset + 1) << 14) |
           (view.getUint8(offset + 2) << 7) |
           view.getUint8(offset + 3);
  }

  function readTextFrame(buf, offset, size) {
    const enc = new Uint8Array(buf)[offset];
    let str = '';
    if (enc === 0 || enc === 3) {
      // ISO-8859-1 or UTF-8
      const decoder = new TextDecoder(enc === 3 ? 'utf-8' : 'iso-8859-1');
      str = decoder.decode(new Uint8Array(buf, offset + 1, size - 1));
    } else if (enc === 1 || enc === 2) {
      // UTF-16
      const decoder = new TextDecoder('utf-16');
      str = decoder.decode(new Uint8Array(buf, offset + 1, size - 1));
    }
    return str.replace(/\0+$/, '').trim();
  }

  function readAPICFrame(buf, offset, size) {
    const bytes = new Uint8Array(buf, offset, size);
    const enc = bytes[0];
    let i = 1;
    // MIME type (null-terminated)
    let mime = '';
    while (i < size && bytes[i] !== 0) { mime += String.fromCharCode(bytes[i]); i++; }
    i++; // skip null
    i++; // skip picture type
    // Description (null-terminated, encoding-dependent)
    if (enc === 0 || enc === 3) {
      while (i < size && bytes[i] !== 0) i++;
      i++;
    } else {
      while (i + 1 < size && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
      i += 2;
    }
    if (i >= size) return null;
    const imgData = buf.slice(offset + i, offset + size);
    if (!mime) mime = 'image/jpeg';
    return new Blob([imgData], { type: mime });
  }

  // ============================================================
  // IndexedDB
  // ============================================================
  const DB_NAME = 'SoloPlayerDB';
  const DB_VERSION = 1;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbPut(store, data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function saveManualPlaylists() {
    for (const pl of state.manualPlaylists) {
      await dbPut('playlists', pl);
    }
  }

  async function loadManualPlaylists() {
    state.manualPlaylists = await dbGetAll('playlists');
  }

  async function saveSettings() {
    await dbPut('settings', {
      key: 'playerState',
      shuffleOn: state.shuffleOn,
      repeatMode: state.repeatMode,
      lastSong: state.currentSong ? state.currentSong.name : null,
      lastFolder: state.currentSong ? state.currentSong.folder : null,
    });
  }

  async function loadSettings() {
    const s = await dbGet('settings', 'playerState');
    if (s) {
      state.shuffleOn = !!s.shuffleOn;
      state.repeatMode = s.repeatMode || 0;
    }
  }

  // ============================================================
  // Folder Loading
  // ============================================================
  async function loadFolder() {
    dlog('loadFolder() called, isNative=' + isNative);
    if (isNative) {
      return loadFolderNative();
    }
    let rootHandle = null;
    let filesFromInput = null;

    if (window.showDirectoryPicker) {
      dlog('Using showDirectoryPicker (native API)');
      try {
        rootHandle = await window.showDirectoryPicker({ mode: 'read' });
        dlog('Directory handle obtained');
      } catch (e) {
        dlog('showDirectoryPicker cancelled/error: ' + e.message);
        return;
      }
    } else {
      dlog('showDirectoryPicker not available, using <input> fallback');
      // Fallback: input element
      filesFromInput = await new Promise(resolve => {
        folderInput.onchange = () => {
          dlog('onchange fired, files: ' + folderInput.files.length);
          resolve(folderInput.files);
        };
        folderInput.click();
        dlog('folderInput.click() called, waiting for user selection...');
      });
      if (!filesFromInput || filesFromInput.length === 0) {
        dlog('No files selected, aborting');
        return;
      }
      dlog('Files received: ' + filesFromInput.length);
      // Log first few paths
      for (let i = 0; i < Math.min(5, filesFromInput.length); i++) {
        dlog('  path[' + i + ']: ' + filesFromInput[i].webkitRelativePath);
      }
    }

    showLoading('Loading music...');
    // Yield to let the browser render the loading overlay
    await sleep(50);

    state.allSongs = [];
    state.autoPlaylists = [];
    state.folderHandles.clear();

    try {
      if (rootHandle) {
        dlog('Starting loadFromDirectoryHandle...');
        await loadFromDirectoryHandle(rootHandle);
      } else {
        dlog('Starting loadFromFileList...');
        await loadFromFileList(filesFromInput);
      }
    } catch (e) {
      dlog('ERROR during loading: ' + e.message + '\n' + e.stack);
    }

    dlog('Loading done. Songs: ' + state.allSongs.length + ', Playlists: ' + state.autoPlaylists.length);

    state.allSongs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    state.autoPlaylists.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    hideLoading();
    landing.classList.add('hidden'); document.body.classList.remove('on-landing');
    app.classList.remove('hidden');
    renderSongList();
    renderPlaylists();
    dlog('UI rendered. Visible songs: ' + state.allSongs.length);

    // Load durations in background (non-blocking)
    loadDurationsInBackground();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // Native (Capacitor) Folder Loading
  // ============================================================
  async function loadFolderNative() {
    dlog('loadFolderNative() start');
    const Plugins = window.Capacitor && window.Capacitor.Plugins;
    if (!Plugins || !Plugins.Filesystem) {
      dlog('ERROR: Capacitor.Plugins.Filesystem not available');
      alert('Filesystem plugin not loaded');
      return;
    }
    const Filesystem = Plugins.Filesystem;

    // Check All Files Access (MANAGE_EXTERNAL_STORAGE)
    if (window.AndroidStorage) {
      try {
        const hasAccess = window.AndroidStorage.hasAllFilesAccess();
        dlog('AllFilesAccess: ' + hasAccess);
        if (!hasAccess) {
          const ok = confirm('このアプリは音楽フォルダを読み込むために「すべてのファイルへのアクセス」が必要です。\n\nOKを押すと設定画面が開きます。\n「すべてのファイルへのアクセスを許可」をオンにしてからアプリに戻ってきてください。');
          if (ok) {
            window.AndroidStorage.openAllFilesAccessSettings();
          }
          return;
        }
      } catch (e) { dlog('AndroidStorage check failed: ' + e.message); }
    }

    // Ask for traditional storage permissions too
    try {
      dlog('Requesting permissions...');
      const perm = await Filesystem.requestPermissions();
      dlog('Permission result: ' + JSON.stringify(perm));
    } catch (e) {
      dlog('Permission request failed: ' + e.message);
    }

    // Get path - default 'Music', allow user to change
    let storedPath = localStorage.getItem('soloplayer:musicPath');
    let path = storedPath || prompt('音楽フォルダのパスを入力してください\n(External Storage基準, 例: Music)', 'Music');
    if (!path) { dlog('Path cancelled'); return; }
    path = path.replace(/^\/+|\/+$/g, '');
    localStorage.setItem('soloplayer:musicPath', path);
    dlog('Music path: ' + path);

    showLoading('Loading music...');
    await sleep(50);

    state.allSongs = [];
    state.autoPlaylists = [];

    // Get root URI first (avoids any path-encoding issues for non-ASCII paths)
    let rootUri = null;
    try {
      const ru = await Filesystem.getUri({ path, directory: 'EXTERNAL_STORAGE' });
      rootUri = ru.uri;
      dlog('Root URI: ' + rootUri);
    } catch (e) {
      dlog('getUri root failed: ' + e.message);
    }

    try {
      const rootName = path.split('/').pop() || path;
      if (rootUri) {
        await scanNativeDir(Filesystem, rootUri, rootName, true, true);
      } else {
        await scanNativeDir(Filesystem, path, rootName, true, false);
      }
    } catch (e) {
      dlog('Native scan ERROR: ' + e.message + '\n' + (e.stack || ''));
      hideLoading();
      alert('フォルダの読み込みに失敗しました:\n' + e.message);
      return;
    }

    dlog('Native loading done. Songs: ' + state.allSongs.length + ', Playlists: ' + state.autoPlaylists.length);

    state.allSongs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    state.autoPlaylists.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    hideLoading();
    landing.classList.add('hidden'); document.body.classList.remove('on-landing');
    app.classList.remove('hidden');
    renderSongList();
    renderPlaylists();
    dlog('UI rendered (native). Songs: ' + state.allSongs.length);

    loadDurationsInBackgroundNative();
  }

  // Recursively scan a native directory.
  // pathOrUri: can be a relative path (with directory='EXTERNAL_STORAGE') OR a full file:// URI
  async function scanNativeDir(Filesystem, pathOrUri, currentFolderName, isRoot, useUri) {
    dlog('scanNativeDir: ' + pathOrUri + ' (useUri=' + !!useUri + ')');
    let result;
    try {
      const args = useUri ? { path: pathOrUri } : { path: pathOrUri, directory: 'EXTERNAL_STORAGE' };
      result = await Filesystem.readdir(args);
    } catch (e) {
      dlog('readdir failed: ' + (e && e.message));
      throw e;
    }
    const files = result.files || [];
    dlog('  -> ' + files.length + ' entries');

    // Log first 3 entries with full detail to diagnose
    if (files.length > 0 && (isRoot || files.length < 3)) {
      for (let i = 0; i < Math.min(3, files.length); i++) {
        const e = files[i];
        dlog('    [' + i + '] name=' + e.name + ' type=' + e.type + ' uri=' + (e.uri || '').slice(0, 80));
      }
    }

    const folderSongs = [];
    let coverUrl = null;

    for (const entry of files) {
      const entryName = entry.name || entry;
      const entryType = entry.type || 'file';
      const entryUri = entry.uri;

      if (entryType === 'directory') {
        // Recurse using the URI directly (avoids path-encoding issues)
        if (isRoot) {
          if (entryUri) {
            await scanNativeDir(Filesystem, entryUri, entryName, false, true);
          } else {
            const childPath = pathOrUri + '/' + entryName;
            await scanNativeDir(Filesystem, childPath, entryName, false, false);
          }
        }
        continue;
      }

      const lower = entryName.toLowerCase();
      if (lower === 'cover.jpg') {
        if (entryUri) {
          coverUrl = window.Capacitor.convertFileSrc(entryUri);
        }
        continue;
      }

      if (lower.endsWith('.mp3') || lower.endsWith('.wav')) {
        if (!entryUri) { dlog('  no uri for ' + entryName); continue; }
        const playUrl = window.Capacitor.convertFileSrc(entryUri);
        const name = entryName.replace(/\.(mp3|wav)$/i, '');
        const song = {
          name,
          file: null,
          nativeUri: entryUri,
          playUrl,
          folder: currentFolderName,
          artUrl: null,
          artist: null,
          duration: 0,
          durationStr: '--:--',
          key: currentFolderName + '/' + entryName,
        };
        folderSongs.push(song);
        state.allSongs.push(song);

        if (state.allSongs.length % 50 === 0) {
          dlog('Songs found: ' + state.allSongs.length);
          updateLoadingText('Loading... ' + state.allSongs.length + ' songs');
          await sleep(0);
        }
      }
    }

    if (folderSongs.length > 0) {
      if (coverUrl) {
        for (const s of folderSongs) {
          if (!s.artUrl) s.artUrl = coverUrl;
        }
      }
      folderSongs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      state.autoPlaylists.push({ name: currentFolderName, coverUrl, songs: folderSongs });
    }
  }

  // Native background duration loading (no ID3 yet — keep it simple)
  async function loadDurationsInBackgroundNative() {
    dlog('Native background metadata loading started');
    for (let i = 0; i < state.allSongs.length; i++) {
      const song = state.allSongs[i];
      try {
        song.durationStr = await getAudioDurationFromUrl(song.playUrl);
        const el = document.querySelector(`[data-key="${CSS.escape(song.key)}"] .song-duration`);
        if (el) el.textContent = song.durationStr;
      } catch (e) { /* skip */ }
      if (i % 3 === 0) await sleep(0);
    }
    dlog('Native background metadata loading complete');
  }

  function getAudioDurationFromUrl(url) {
    return new Promise(resolve => {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = url;
      a.onloadedmetadata = () => {
        const dur = a.duration;
        resolve(isFinite(dur) ? formatTime(dur) : '--:--');
      };
      a.onerror = () => resolve('--:--');
      setTimeout(() => resolve('--:--'), 5000);
    });
  }

  async function loadFromDirectoryHandle(rootHandle) {
    for await (const [name, handle] of rootHandle.entries()) {
      if (handle.kind !== 'directory') continue;

      const folderSongs = [];
      let coverUrl = null;
      state.folderHandles.set(name, handle);

      for await (const [fname, fhandle] of handle.entries()) {
        if (fhandle.kind !== 'file') continue;
        const lower = fname.toLowerCase();

        if (lower === 'cover.jpg') {
          const file = await fhandle.getFile();
          coverUrl = URL.createObjectURL(file);
          continue;
        }

        if (lower.endsWith('.mp3') || lower.endsWith('.wav')) {
          const file = await fhandle.getFile();
          const song = await buildSongEntry(file, name);
          folderSongs.push(song);
          state.allSongs.push(song);
        }
      }

      // Apply cover.jpg to songs without embedded art
      if (coverUrl) {
        for (const s of folderSongs) {
          if (!s.artUrl) s.artUrl = coverUrl;
        }
      }

      if (folderSongs.length > 0) {
        folderSongs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        state.autoPlaylists.push({ name, coverUrl, songs: folderSongs });
      }
    }
  }

  async function loadFromFileList(files) {
    const folders = new Map(); // folderName -> { songs, coverUrl, coverFile }
    let skippedCount = 0;
    let processedCount = 0;

    dlog('loadFromFileList: total files = ' + files.length);

    for (const file of files) {
      const parts = file.webkitRelativePath.split('/');
      if (parts.length < 2) { skippedCount++; continue; }
      // Support both root/file.mp3 (2 levels) and root/folder/file.mp3 (3 levels)
      let folderName, fileName;
      if (parts.length === 2) {
        folderName = '(root)';
        fileName = parts[1];
      } else if (parts.length === 3) {
        folderName = parts[1];
        fileName = parts[2];
      } else {
        // Deeper nesting: use the first subfolder as the group
        folderName = parts[1];
        fileName = parts[parts.length - 1];
      }
      processedCount++;

      if (!folders.has(folderName)) {
        folders.set(folderName, { songs: [], coverUrl: null });
      }
      const folder = folders.get(folderName);
      const lower = fileName.toLowerCase();

      if (lower === 'cover.jpg') {
        folder.coverUrl = URL.createObjectURL(file);
        continue;
      }

      if (lower.endsWith('.mp3') || lower.endsWith('.wav')) {
        // Fast entry: skip ID3 parsing during initial load
        const name = fileName.replace(/\.(mp3|wav)$/i, '');
        const song = {
          name,
          file,
          folder: folderName,
          artUrl: null,
          artist: null,
          duration: 0,
          durationStr: '--:--',
          key: folderName + '/' + fileName,
        };
        folder.songs.push(song);
        state.allSongs.push(song);

        if (state.allSongs.length % 50 === 0) {
          dlog('Songs loaded: ' + state.allSongs.length);
          updateLoadingText('Loading... ' + state.allSongs.length + ' songs');
          await sleep(0);
        }
      }
    }

    dlog('File scan done. processed=' + processedCount + ' skipped=' + skippedCount + ' songs=' + state.allSongs.length);
    dlog('Folders found: ' + [...folders.keys()].join(', '));

    for (const [name, folder] of folders) {
      if (folder.coverUrl) {
        for (const s of folder.songs) {
          if (!s.artUrl) s.artUrl = folder.coverUrl;
        }
      }
      if (folder.songs.length > 0) {
        folder.songs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        state.autoPlaylists.push({ name, coverUrl: folder.coverUrl, songs: folder.songs });
      }
    }
  }

  let songCounter = 0;

  async function buildSongEntry(file, folder) {
    // Parse ID3 only every 20 files yield to keep UI responsive
    songCounter++;
    if (songCounter % 20 === 0) {
      updateLoadingText(`Loading music... (${songCounter} files)`);
      await sleep(0);
    }

    let artUrl = null;
    let artist = null;
    try {
      const id3 = await parseID3(file);
      artUrl = id3.artBlob ? URL.createObjectURL(id3.artBlob) : null;
      artist = id3.artist || null;
    } catch (e) { /* skip ID3 errors */ }

    const name = file.name.replace(/\.(mp3|wav)$/i, '');

    return {
      name,
      file,
      folder,
      artUrl,
      artist,
      duration: 0,
      durationStr: '--:--',
      key: folder + '/' + file.name,
    };
  }

  // Load ID3 tags + durations lazily in the background after initial render
  async function loadDurationsInBackground() {
    dlog('Background metadata loading started (' + state.allSongs.length + ' songs)');
    for (let i = 0; i < state.allSongs.length; i++) {
      const song = state.allSongs[i];
      try {
        // ID3 parse (art + artist)
        const id3 = await parseID3(song.file);
        if (id3.artBlob && !song.artUrl) {
          song.artUrl = URL.createObjectURL(id3.artBlob);
          const songEl = document.querySelector(`[data-key="${CSS.escape(song.key)}"]`);
          if (songEl) {
            const placeholderEl = songEl.querySelector('.song-art-placeholder');
            if (placeholderEl) {
              // Replace placeholder with actual image
              const img = document.createElement('img');
              img.className = 'song-art';
              img.src = song.artUrl;
              img.alt = '';
              img.loading = 'lazy';
              placeholderEl.replaceWith(img);
            }
          }
        }
        if (id3.artist) song.artist = id3.artist;
      } catch (e) { /* skip */ }
      try {
        // Duration
        song.durationStr = await getAudioDuration(song.file);
        const el = document.querySelector(`[data-key="${CSS.escape(song.key)}"] .song-duration`);
        if (el) el.textContent = song.durationStr;
      } catch (e) { /* skip */ }
      // Yield every 3 songs to keep UI responsive
      if (i % 3 === 0) await sleep(0);
    }
    dlog('Background metadata loading complete');
  }

  function getAudioDuration(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = 'metadata';
      a.src = url;
      a.onloadedmetadata = () => {
        const dur = a.duration;
        URL.revokeObjectURL(url);
        resolve(isFinite(dur) ? formatTime(dur) : '--:--');
      };
      a.onerror = () => {
        URL.revokeObjectURL(url);
        resolve('--:--');
      };
      // Timeout: if metadata doesn't load in 5s, skip
      setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve('--:--');
      }, 5000);
    });
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  // ============================================================
  // Rendering
  // ============================================================
  function renderSongList(filter = '') {
    const songs = filter
      ? state.allSongs.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()))
      : state.allSongs;

    if (songs.length === 0) {
      songListEl.innerHTML = `<div class="empty-state">${filter ? 'No songs found' : 'No songs loaded'}</div>`;
      return;
    }

    songListEl.innerHTML = songs.map((s, i) => songItemHTML(s, i)).join('');
    updatePlayingHighlight();
  }

  // Aurora playlist accent colors (cycled per card)
  const PL_ACCENTS = ['#7be8ff', '#8b6cff', '#5cf2c8', '#3b8cff', '#ff6aa8'];
  const PL_ICONS = ['♪', '◎', '✦', '☾', '↻', '♥'];

  function songItemHTML(song, index) {
    const num = String((index || 0) + 1).padStart(2, '0');
    const artHTML = song.artUrl
      ? `<img class="song-art" src="${escapeAttr(song.artUrl)}" alt="" loading="lazy">`
      : `<div class="song-art-placeholder"></div>`;
    return `<div class="song-item" data-key="${escapeAttr(song.key)}">
      <div class="song-num">${num}</div>
      ${artHTML}
      <div class="song-info">
        <div class="song-title">${escapeHTML(song.name)}</div>
        <div class="song-meta">${escapeHTML(song.artist || song.folder || '')}</div>
      </div>
      <div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="song-dur">${song.durationStr}</div>
      <button class="song-menu-btn" data-menu-key="${escapeAttr(song.key)}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
        </svg>
      </button>
    </div>`;
  }

  function playlistCardHTML(name, count, idx, dataAttr, accent, icon) {
    const num = String(idx + 1).padStart(2, '0');
    return `<div class="playlist-card" ${dataAttr} style="--c:${accent}">
      <div class="pc-id">SP/${num}</div>
      <div class="pc-hole"></div>
      <div class="pc-name">${escapeHTML(name)}</div>
      <div class="pc-bottom"></div>
      <div class="pc-meta">${count} TRX</div>
      <div class="pc-icon">${icon}</div>
    </div>`;
  }

  function renderPlaylists() {
    // Auto playlists
    if (state.autoPlaylists.length === 0) {
      autoPlaylistsEl.innerHTML = '<div class="empty-state">No auto playlists</div>';
    } else {
      autoPlaylistsEl.innerHTML = state.autoPlaylists.map((pl, i) => {
        const accent = PL_ACCENTS[i % PL_ACCENTS.length];
        const icon = PL_ICONS[i % PL_ICONS.length];
        return playlistCardHTML(pl.name, pl.songs.length, i, `data-auto="${escapeAttr(pl.name)}"`, accent, icon);
      }).join('');
    }

    // Manual playlists
    renderManualPlaylists();
  }

  function renderManualPlaylists() {
    if (state.manualPlaylists.length === 0) {
      manualPlaylistsEl.innerHTML = '<div class="empty-state">No playlists yet</div>';
      return;
    }
    manualPlaylistsEl.innerHTML = state.manualPlaylists.map((pl, i) => {
      const songs = getManualPlaylistSongs(pl);
      const accent = PL_ACCENTS[(i + 2) % PL_ACCENTS.length];
      const icon = PL_ICONS[(i + 3) % PL_ICONS.length];
      return playlistCardHTML(pl.name, songs.length, i + state.autoPlaylists.length, `data-manual="${escapeAttr(pl.id)}"`, accent, icon);
    }).join('');
  }

  function getManualPlaylistSongs(pl) {
    return pl.songKeys
      .map(key => state.allSongs.find(s => s.key === key))
      .filter(Boolean);
  }

  function showPlaylistDetail(songs, title, coverUrl, isManual, playlistId) {
    const detailTitle = $('detailTitle');
    const detailCount = $('detailCount');
    const detailCover = $('detailCover');
    const detailActions = $('detailActions');
    const detailSongList = $('detailSongList');

    detailTitle.textContent = title;
    detailCount.textContent = songs.length + ' songs';

    if (coverUrl) {
      detailCover.src = coverUrl;
      detailCover.classList.remove('hidden');
    } else if (songs.length > 0 && songs[0].artUrl) {
      detailCover.src = songs[0].artUrl;
      detailCover.classList.remove('hidden');
    } else {
      detailCover.classList.add('hidden');
    }

    // Actions
    let actionsHTML = `<button class="btn-action" data-detail-action="playAll">Play All</button>`;
    if (isManual) {
      actionsHTML += `<button class="btn-action danger" data-detail-action="delete" data-pl-id="${escapeAttr(playlistId)}">Delete</button>`;
    }
    detailActions.innerHTML = actionsHTML;

    // Song list
    detailSongList.innerHTML = songs.map((s, i) => {
      let extra = '';
      if (isManual) {
        extra = `<button class="song-menu-btn" data-remove-key="${escapeAttr(s.key)}" data-pl-id="${escapeAttr(playlistId)}" title="Remove">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="#ff6aa8"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>`;
      }
      const num = String(i + 1).padStart(2, '0');
      const artHTML = s.artUrl
        ? `<img class="song-art" src="${escapeAttr(s.artUrl)}" alt="" loading="lazy">`
        : `<div class="song-art-placeholder"></div>`;
      return `<div class="song-item" data-key="${escapeAttr(s.key)}">
        <div class="song-num">${num}</div>
        ${artHTML}
        <div class="song-info">
          <div class="song-title">${escapeHTML(s.name)}</div>
          <div class="song-meta">${escapeHTML(s.artist || s.folder || '')}</div>
        </div>
        <div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
        <div class="song-dur">${s.durationStr}</div>
        ${extra}
      </div>`;
    }).join('');

    // Store context for playAll
    playlistDetail._songs = songs;
    playlistDetail._context = isManual
      ? { type: 'manual', id: playlistId }
      : { type: 'auto', name: title };

    songsTab.classList.remove('active');
    playlistsTab.classList.remove('active');
    playlistDetail.classList.add('active');
    $('searchBar').classList.add('hidden');
    updatePlayingHighlight();
  }

  function hidePlaylistDetail() {
    playlistDetail.classList.remove('active');
    playlistsTab.classList.add('active');
    $('searchBar').classList.add('hidden');
  }

  function updatePlayingHighlight() {
    document.querySelectorAll('.song-item').forEach(el => {
      el.classList.toggle('playing', state.currentSong && el.dataset.key === state.currentSong.key);
    });
  }

  // ============================================================
  // Playback
  // ============================================================
  function getSongPlaybackUrl(song) {
    if (song.playUrl) return song.playUrl;
    if (song.file) return URL.createObjectURL(song.file);
    return null;
  }

  function playSong(song, queue, context) {
    if (!song) return;
    const url = getSongPlaybackUrl(song);
    if (!url) { dlog('No playback URL for song'); return; }

    state.currentSong = song;
    state.playingContext = context;

    // Build queue
    if (queue) {
      state.currentQueue = [...queue];
      state.currentIndex = state.currentQueue.indexOf(song);
      if (state.currentIndex < 0) state.currentIndex = 0;
    }

    if (state.shuffleOn) shuffleQueue();

    audio.src = url;
    audio.play().catch(e => dlog('audio.play error: ' + e.message));
    state.isPlaying = true;

    updateMiniPlayer();
    updateNowPlaying();
    updatePlayPauseIcons();
    updateMediaSession();
    updatePlayingHighlight();
    miniPlayer.classList.remove('hidden');
    saveSettings();
  }

  function togglePlayPause() {
    if (!state.currentSong) return;
    if (audio.paused) {
      audio.play().catch(() => {});
      state.isPlaying = true;
    } else {
      audio.pause();
      state.isPlaying = false;
    }
    updatePlayPauseIcons();
  }

  function playNext() {
    if (state.currentQueue.length === 0) return;
    if (state.repeatMode === 2) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let next = state.currentIndex + 1;
    if (next >= state.currentQueue.length) {
      if (state.repeatMode === 1) next = 0;
      else { audio.pause(); state.isPlaying = false; updatePlayPauseIcons(); return; }
    }
    state.currentIndex = next;
    playSongAtIndex(next);
  }

  function playPrev() {
    if (state.currentQueue.length === 0) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prev = state.currentIndex - 1;
    if (prev < 0) {
      if (state.repeatMode === 1) prev = state.currentQueue.length - 1;
      else prev = 0;
    }
    state.currentIndex = prev;
    playSongAtIndex(prev);
  }

  function playSongAtIndex(idx) {
    const song = state.currentQueue[idx];
    if (!song) return;
    const url = getSongPlaybackUrl(song);
    if (!url) return;
    state.currentSong = song;
    state.currentIndex = idx;
    audio.src = url;
    audio.play().catch(e => dlog('audio.play error: ' + e.message));
    state.isPlaying = true;
    updateMiniPlayer();
    updateNowPlaying();
    updatePlayPauseIcons();
    updateMediaSession();
    updatePlayingHighlight();
    saveSettings();
  }

  function shuffleQueue() {
    if (!state.currentSong) return;
    const current = state.currentSong;
    const others = state.currentQueue.filter(s => s !== current);
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    state.currentQueue = [current, ...others];
    state.currentIndex = 0;
  }

  function toggleShuffle() {
    state.shuffleOn = !state.shuffleOn;
    if (state.shuffleOn) {
      shuffleQueue();
    } else {
      // Restore original order from context
      rebuildQueue();
    }
    updateShuffleIcon();
    saveSettings();
  }

  function toggleRepeat() {
    state.repeatMode = (state.repeatMode + 1) % 3;
    updateRepeatIcon();
    saveSettings();
  }

  function rebuildQueue() {
    const ctx = state.playingContext;
    if (!ctx) return;
    let songs;
    if (ctx.type === 'all') {
      songs = [...state.allSongs];
    } else if (ctx.type === 'auto') {
      const pl = state.autoPlaylists.find(p => p.name === ctx.name);
      songs = pl ? [...pl.songs] : [];
    } else if (ctx.type === 'manual') {
      const pl = state.manualPlaylists.find(p => p.id === ctx.id);
      songs = pl ? getManualPlaylistSongs(pl) : [];
    }
    if (songs) {
      state.currentQueue = songs;
      state.currentIndex = songs.indexOf(state.currentSong);
      if (state.currentIndex < 0) state.currentIndex = 0;
    }
  }

  // ============================================================
  // UI Updates
  // ============================================================
  function updatePlayPauseIcons() {
    const playing = state.isPlaying;
    $('miniPlayIcon').classList.toggle('hidden', playing);
    $('miniPauseIcon').classList.toggle('hidden', !playing);
    $('npPlayIcon').classList.toggle('hidden', playing);
    $('npPauseIcon').classList.toggle('hidden', !playing);
    // Spin mini-art only while playing
    $('miniArt').classList.toggle('playing', playing);
    $('miniArtPlaceholder').classList.toggle('playing', playing);
  }

  function updateMiniPlayer() {
    const s = state.currentSong;
    if (!s) return;
    $('miniTitle').textContent = s.name;
    $('miniArtist').textContent = s.artist || '';
    if (s.artUrl) {
      $('miniArt').src = s.artUrl;
      $('miniArt').classList.remove('hidden');
      $('miniArtPlaceholder').classList.add('hidden');
    } else {
      $('miniArt').classList.add('hidden');
      $('miniArtPlaceholder').classList.remove('hidden');
    }
  }

  function updateNowPlaying() {
    const s = state.currentSong;
    if (!s) return;
    $('npTitle').textContent = s.name;
    $('npArtist').textContent = s.artist || '';
    if (s.artUrl) {
      $('npArt').src = s.artUrl;
      $('npArt').classList.remove('hidden');
      $('npArtPlaceholder').classList.add('hidden');
    } else {
      $('npArt').classList.add('hidden');
      $('npArtPlaceholder').classList.remove('hidden');
    }
    updateShuffleIcon();
    updateRepeatIcon();
  }

  function updateShuffleIcon() {
    $('npShuffle').classList.toggle('active', state.shuffleOn);
  }

  function updateRepeatIcon() {
    const btn = $('npRepeat');
    btn.classList.toggle('active', state.repeatMode > 0);
    $('npRepeatIcon').classList.toggle('hidden', state.repeatMode === 2);
    $('npRepeatOneIcon').classList.toggle('hidden', state.repeatMode !== 2);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = state.currentSong;
    if (!s) return;

    const artwork = [];
    if (s.artUrl) {
      artwork.push({ src: s.artUrl, sizes: '512x512', type: 'image/jpeg' });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.name,
      artist: s.artist || '',
      album: s.folder || '',
      artwork,
    });

    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime != null) audio.currentTime = d.seekTime;
    });
  }

  // ============================================================
  // Loading Overlay
  // ============================================================
  let loadingEl = null;
  function showLoading(text) {
    loadingEl = document.createElement('div');
    loadingEl.className = 'loading-overlay';
    loadingEl.innerHTML = `<div class="spinner"></div><div class="loading-text">${escapeHTML(text)}</div>`;
    document.body.appendChild(loadingEl);
  }
  function hideLoading() {
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
  }
  function updateLoadingText(text) {
    if (loadingEl) {
      const el = loadingEl.querySelector('.loading-text');
      if (el) el.textContent = text;
    }
  }

  // ============================================================
  // Manual Playlists
  // ============================================================
  function createManualPlaylist(name) {
    const pl = {
      id: 'pl_' + Date.now(),
      name,
      songKeys: [],
    };
    state.manualPlaylists.push(pl);
    dbPut('playlists', pl);
    renderManualPlaylists();
    return pl;
  }

  function addSongToPlaylist(playlistId, songKey) {
    const pl = state.manualPlaylists.find(p => p.id === playlistId);
    if (!pl) return;
    if (!pl.songKeys.includes(songKey)) {
      pl.songKeys.push(songKey);
      dbPut('playlists', pl);
    }
  }

  function removeSongFromPlaylist(playlistId, songKey) {
    const pl = state.manualPlaylists.find(p => p.id === playlistId);
    if (!pl) return;
    pl.songKeys = pl.songKeys.filter(k => k !== songKey);
    dbPut('playlists', pl);
  }

  function deleteManualPlaylist(playlistId) {
    state.manualPlaylists = state.manualPlaylists.filter(p => p.id !== playlistId);
    dbDelete('playlists', playlistId);
    renderManualPlaylists();
  }

  // ============================================================
  // Modals
  // ============================================================
  function showAddToPlaylistModal(songKey) {
    const modal = $('addToPlaylistModal');
    const choices = $('playlistChoices');
    choices.innerHTML = state.manualPlaylists.map(pl =>
      `<div class="playlist-choice" data-pl-id="${escapeAttr(pl.id)}" data-song-key="${escapeAttr(songKey)}">
        <span class="playlist-choice-name">${escapeHTML(pl.name)}</span>
      </div>`
    ).join('');

    if (state.manualPlaylists.length === 0) {
      choices.innerHTML = '<div class="empty-state">Create a playlist first</div>';
    }
    modal.classList.remove('hidden');
  }

  function showNewPlaylistModal() {
    $('newPlaylistName').value = '';
    $('newPlaylistModal').classList.remove('hidden');
    setTimeout(() => $('newPlaylistName').focus(), 100);
  }

  // ============================================================
  // Event Handlers
  // ============================================================
  function setupEvents() {
    // Folder selection
    btnSelectFolder.addEventListener('click', loadFolder);
    btnReload.addEventListener('click', loadFolder);

    // Tabs
    function switchTab(target) {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === target);
      });
      songsTab.classList.toggle('active', target === 'songs');
      playlistsTab.classList.toggle('active', target === 'playlists');
      playlistDetail.classList.remove('active');
      $('searchBar').classList.toggle('hidden', target !== 'songs');
    }
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Swipe between tabs (horizontal swipe on tab content area)
    const TABS_ORDER = ['songs', 'playlists'];
    let touchStartX = 0, touchStartY = 0, touchTracking = false;
    function getActiveTab() {
      if (songsTab.classList.contains('active')) return 'songs';
      if (playlistsTab.classList.contains('active')) return 'playlists';
      return null;
    }
    function onTouchStart(e) {
      // Only handle when on a top-level tab (not detail view)
      if (playlistDetail.classList.contains('active')) { touchTracking = false; return; }
      if (e.touches.length !== 1) { touchTracking = false; return; }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchTracking = true;
    }
    function onTouchEnd(e) {
      if (!touchTracking) return;
      touchTracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      // Require horizontal swipe: |dx| > 60 and dominant horizontal direction
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const current = getActiveTab();
      if (!current) return;
      const idx = TABS_ORDER.indexOf(current);
      const nextIdx = dx < 0 ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= TABS_ORDER.length) return;
      switchTab(TABS_ORDER[nextIdx]);
    }
    [songsTab, playlistsTab].forEach(el => {
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchend', onTouchEnd, { passive: true });
    });

    // Search
    searchInput.addEventListener('input', () => {
      renderSongList(searchInput.value);
    });

    // Song list click
    songListEl.addEventListener('click', e => {
      const menuBtn = e.target.closest('.song-menu-btn');
      if (menuBtn) {
        e.stopPropagation();
        showContextMenu(menuBtn, menuBtn.dataset.menuKey);
        return;
      }
      const item = e.target.closest('.song-item');
      if (item) {
        const song = state.allSongs.find(s => s.key === item.dataset.key);
        if (song) playSong(song, state.allSongs, { type: 'all' });
      }
    });

    // Auto playlist click
    autoPlaylistsEl.addEventListener('click', e => {
      const card = e.target.closest('.playlist-card');
      if (card) {
        const pl = state.autoPlaylists.find(p => p.name === card.dataset.auto);
        if (pl) showPlaylistDetail(pl.songs, pl.name, pl.coverUrl, false, null);
      }
    });

    // Manual playlist click
    manualPlaylistsEl.addEventListener('click', e => {
      const card = e.target.closest('.playlist-card');
      if (card) {
        const pl = state.manualPlaylists.find(p => p.id === card.dataset.manual);
        if (pl) {
          const songs = getManualPlaylistSongs(pl);
          const coverUrl = songs.length > 0 ? songs[0].artUrl : null;
          showPlaylistDetail(songs, pl.name, coverUrl, true, pl.id);
        }
      }
    });

    // Playlist detail events
    $('btnBackFromDetail').addEventListener('click', hidePlaylistDetail);

    $('detailActions').addEventListener('click', e => {
      const btn = e.target.closest('.btn-action');
      if (!btn) return;
      const action = btn.dataset.detailAction;
      if (action === 'playAll') {
        const songs = playlistDetail._songs;
        if (songs && songs.length > 0) {
          playSong(songs[0], songs, playlistDetail._context);
        }
      } else if (action === 'delete') {
        deleteManualPlaylist(btn.dataset.plId);
        hidePlaylistDetail();
      }
    });

    $('detailSongList').addEventListener('click', e => {
      // Remove from manual playlist
      const removeBtn = e.target.closest('[data-remove-key]');
      if (removeBtn) {
        e.stopPropagation();
        removeSongFromPlaylist(removeBtn.dataset.plId, removeBtn.dataset.removeKey);
        // Re-render detail
        const pl = state.manualPlaylists.find(p => p.id === removeBtn.dataset.plId);
        if (pl) {
          const songs = getManualPlaylistSongs(pl);
          showPlaylistDetail(songs, pl.name, songs[0]?.artUrl, true, pl.id);
        }
        return;
      }
      const item = e.target.closest('.song-item');
      if (item) {
        const song = state.allSongs.find(s => s.key === item.dataset.key);
        const songs = playlistDetail._songs;
        if (song && songs) playSong(song, songs, playlistDetail._context);
      }
    });

    // New playlist
    btnNewPlaylist.addEventListener('click', showNewPlaylistModal);
    $('btnCancelNew').addEventListener('click', () => $('newPlaylistModal').classList.add('hidden'));
    $('btnCreatePlaylist').addEventListener('click', () => {
      const name = $('newPlaylistName').value.trim();
      if (name) {
        createManualPlaylist(name);
        $('newPlaylistModal').classList.add('hidden');
      }
    });
    $('newPlaylistName').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const name = $('newPlaylistName').value.trim();
        if (name) {
          createManualPlaylist(name);
          $('newPlaylistModal').classList.add('hidden');
        }
      }
    });

    // Add to playlist modal
    $('btnCancelAdd').addEventListener('click', () => $('addToPlaylistModal').classList.add('hidden'));
    $('playlistChoices').addEventListener('click', e => {
      const choice = e.target.closest('.playlist-choice');
      if (choice) {
        addSongToPlaylist(choice.dataset.plId, choice.dataset.songKey);
        $('addToPlaylistModal').classList.add('hidden');
      }
    });

    // Mini player
    $('miniPlayPause').addEventListener('click', e => { e.stopPropagation(); togglePlayPause(); });
    $('miniPrev').addEventListener('click', e => { e.stopPropagation(); playPrev(); });
    $('miniNext').addEventListener('click', e => { e.stopPropagation(); playNext(); });
    $('miniContent').addEventListener('click', () => {
      if (state.currentSong) nowPlayingEl.classList.remove('hidden');
    });

    // Now Playing controls
    $('btnCloseNP').addEventListener('click', () => nowPlayingEl.classList.add('hidden'));
    $('npPlayPause').addEventListener('click', togglePlayPause);
    $('npPrev').addEventListener('click', playPrev);
    $('npNext').addEventListener('click', playNext);
    $('npShuffle').addEventListener('click', toggleShuffle);
    $('npRepeat').addEventListener('click', toggleRepeat);

    // Seek bar
    const seekBar = $('npSeekBar');
    let seeking = false;
    seekBar.addEventListener('input', () => {
      seeking = true;
      $('npCurrentTime').textContent = formatTime((seekBar.value / 100) * audio.duration || 0);
    });
    seekBar.addEventListener('change', () => {
      if (audio.duration) audio.currentTime = (seekBar.value / 100) * audio.duration;
      seeking = false;
    });

    // Audio events
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration || seeking) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      seekBar.value = pct;
      seekBar.style.setProperty('--p', pct + '%');
      $('npCurrentTime').textContent = formatTime(audio.currentTime);
      $('npDuration').textContent = formatTime(audio.duration);
      $('miniProgress').style.width = pct + '%';
    });

    audio.addEventListener('ended', () => playNext());
    audio.addEventListener('play', () => { state.isPlaying = true; updatePlayPauseIcons(); });
    audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayPauseIcons(); });

    // Context menu
    document.addEventListener('click', () => {
      $('songContextMenu').classList.add('hidden');
    });

    // Modal overlays
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', () => {
        overlay.closest('.modal').classList.add('hidden');
      });
    });
  }

  function showContextMenu(btn, songKey) {
    const menu = $('songContextMenu');
    const rect = btn.getBoundingClientRect();
    menu.style.top = Math.min(rect.bottom, window.innerHeight - 60) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
    menu.classList.remove('hidden');
    menu._songKey = songKey;

    // Re-bind action
    menu.querySelector('[data-action="addToPlaylist"]').onclick = e => {
      e.stopPropagation();
      menu.classList.add('hidden');
      showAddToPlaylistModal(songKey);
    };
  }

  // ============================================================
  // Utility
  // ============================================================
  function escapeHTML(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // Init
  // ============================================================
  async function init() {
    dlog('init() start');
    dlog('UA: ' + navigator.userAgent);
    dlog('showDirectoryPicker: ' + !!window.showDirectoryPicker);
    document.body.classList.add('on-landing');
    try {
      await openDB();
      dlog('IndexedDB opened');
      await loadManualPlaylists();
      await loadSettings();
      setupEvents();
      dlog('init() done, ready');
    } catch (e) {
      dlog('init ERROR: ' + e.message);
    }

    // Register Service Worker (web only — Capacitor serves from localhost)
    if ('serviceWorker' in navigator && !isNative) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // Auto-resume on native if path already chosen and permission granted
    if (isNative) {
      const storedPath = localStorage.getItem('soloplayer:musicPath');
      if (storedPath) {
        let hasAccess = true;
        try {
          if (window.AndroidStorage && typeof window.AndroidStorage.hasAllFilesAccess === 'function') {
            hasAccess = window.AndroidStorage.hasAllFilesAccess();
          }
        } catch (e) { dlog('hasAllFilesAccess check failed: ' + e.message); }
        if (hasAccess) {
          dlog('Auto-loading saved folder: ' + storedPath);
          // Skip the landing screen and load straight away
          loadFolderNative();
        }
      }
    }
  }

  init();
})();
