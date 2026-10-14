const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the UI');
};

function start({ selected, documents, legacy, failFetch = false, idb } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const releases = [];
  const alerts = [];
  const audios = [];
  const fetches = [];
  const native = [];
  class Audio extends window.EventTarget {
    constructor() {
      super();
      this.paused = true; this.ended = false; this.error = null;
      this.duration = 60; this.currentTime = 0; this.plays = 0;
      audios.push(this);
    }
    set src(value) { this._src = value; this.ended = false; queueMicrotask(() => this.onloadedmetadata?.()); }
    get src() { return this._src || ''; }
    removeAttribute() { this._src = ''; }
    load() {}
    play() {
      this.plays++; this.paused = false; this.ended = false;
      this.dispatchEvent(new window.Event('play'));
      return Promise.resolve();
    }
    pause() {
      if (this.paused) return; // real media elements only fire 'pause' on a change
      this.paused = true;
      this.dispatchEvent(new window.Event('pause'));
    }
    // Natural end of a track, in the spec's event order: 'pause' then 'ended'.
    finish() {
      this.currentTime = this.duration; this.paused = true; this.ended = true;
      this.dispatchEvent(new window.Event('pause'));
      this.dispatchEvent(new window.Event('ended'));
    }
  }
  window.Audio = Audio;
  window.URL.createObjectURL = blob => `blob:${blob.tag}`;
  window.URL.revokeObjectURL = () => {};
  // The WebView's own fetch (CapacitorHttp keeps it here when it patches window.fetch).
  window.CapacitorWebFetch = async url => {
    fetches.push(url);
    if (failFetch) throw new Error('fetch failed');
    return { ok: true, status: 200, blob: async () => ({ tag: url.split('/').pop() }) };
  };
  window.indexedDB = idb || new IDBFactory();
  window.CSS.escape = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  window.alert = message => alerts.push(message);
  window.confirm = () => true;
  window.Capacitor = {
    isNativePlatform: () => true,
    convertFileSrc: uri => `http://localhost/_capacitor_content_${uri}`,
    Plugins: {
      Filesystem: {
        getUri: async () => ({ uri: 'file:///Music' }),
        readdir: async ({ path: uri }) => ({ files: legacy[uri] || [] }),
        requestPermissions: async () => ({}),
      },
    },
  };
  window.AndroidStorage = { hasAllFilesAccess: () => true };
  window.AndroidPlayback = {
    start: () => native.push('start'),
    update: (title, artist, playing) => native.push(`update:${playing}`),
    stop: () => native.push('stop'),
  };
  window.AndroidFolders = {
    chooseFolder: () => queueMicrotask(() => window.SoloPlayerNative.onFolderSelected(selected.shift())),
    listDocuments: (tree, parent, id) => queueMicrotask(() => {
      const entries = documents[`${tree}/${parent}`] || [];
      window.SoloPlayerNative.onFolderEntries(id, JSON.stringify({ entries }));
    }),
    releaseFolder: uri => releases.push(uri),
    isDirectory: uri => uri.includes('millsage'),
  };
  if (legacy) window.localStorage.setItem('soloplayer:musicPath', 'Music');
  window.eval(script);
  return { window, dom, releases, alerts, audios, fetches, native };
}

const dir = (id, name) => ({ id, name, directory: true, mime: 'vnd.android.document/directory' });
const song = (id, name) => ({ id, name, directory: false, uri: `content://provider/document/${id}` });
const click = (window, selector) => {
  const el = window.document.querySelector(selector);
  assert.ok(el, selector);
  el.click();
};

test('SAF discovers regular and music-icon folders, navigates back and replaces library', async () => {
  const documents = {
    'tree:old/': [dir('regular', 'regular'), dir('millsage', 'millsage'), dir('Download', 'Download')],
    'tree:old/regular': [song('a', 'a.mp3')],
    'tree:old/millsage': [song('b', 'b.wav')],
    'tree:old/Download': [song('c', 'c.mp3')],
    'tree:new/': [dir('new', 'new')],
    'tree:new/new': [song('d', 'd.mp3')],
    'tree:empty/': [],
  };
  const { window, releases, alerts } = start({ selected: ['tree:old', 'tree:empty', 'tree:new'], documents });
  await new Promise(resolve => setTimeout(resolve, 50));
  click(window, '#btnSelectFolder');
  await waitFor(() => window.document.querySelectorAll('#songList .song-item').length === 3);
  assert.equal(window.localStorage.getItem('soloplayer:treeUri'), 'tree:old');
  assert.match(window.document.getElementById('autoPlaylists').textContent, /millsage/);
  assert.match(window.document.getElementById('autoPlaylists').textContent, /Download/);

  click(window, '[data-tab="playlists"]');
  click(window, '#autoPlaylists .playlist-card');
  assert.ok(window.document.getElementById('playlistDetail').classList.contains('active'));
  assert.equal(window.SoloPlayerNative.onBack(), true);
  assert.ok(window.document.getElementById('playlistsTab').classList.contains('active'));
  click(window, '#autoPlaylists .playlist-card');
  click(window, '#detailSongList .song-item');
  click(window, '#miniContent');
  assert.equal(window.SoloPlayerNative.onBack(), true);
  assert.ok(window.document.getElementById('nowPlaying').classList.contains('hidden'));
  assert.ok(window.document.getElementById('playlistDetail').classList.contains('active'));
  window.SoloPlayerNative.onAction('pause');
  assert.equal(window.document.getElementById('miniPlayer').classList.contains('hidden'), false);
  window.SoloPlayerNative.onAction('play');
  window.SoloPlayerNative.onAction('next');
  window.SoloPlayerNative.onAction('prev');

  click(window, '#btnSettings');
  assert.equal(window.SoloPlayerNative.onBack(), true);
  assert.ok(window.document.getElementById('settingsModal').classList.contains('hidden'));
  click(window, '#btnSettings');
  click(window, '#btnChangeFolder'); // Empty selection must roll back.
  await waitFor(() => alerts.length === 1);
  assert.equal(window.localStorage.getItem('soloplayer:treeUri'), 'tree:old');
  assert.deepEqual(releases, ['tree:empty']);
  click(window, '#btnSettings');
  click(window, '#btnChangeFolder');
  await waitFor(() => window.localStorage.getItem('soloplayer:treeUri') === 'tree:new');
  assert.equal(window.document.querySelectorAll('#songList .song-item').length, 1);
  assert.match(window.document.getElementById('songList').textContent, /d/);
  assert.doesNotMatch(window.document.getElementById('songList').textContent, /a\.mp3|b\.wav|c\.mp3/);
  assert.deepEqual(releases, ['tree:empty', 'tree:old']);
  assert.equal(window.localStorage.getItem('soloplayer:musicPath'), null);
  assert.equal(window.SoloPlayerNative.onBack(), false);
});

test('media transport play/pause/next/previous acts on the existing queue', async () => {
  const documents = {
    'tree:music/': [dir('album', 'album')],
    'tree:music/album': [song('one', 'one.mp3'), song('two', 'two.mp3')],
  };
  const { window, audios } = start({ selected: ['tree:music'], documents });
  await new Promise(resolve => setTimeout(resolve, 50));
  click(window, '#btnSelectFolder');
  await waitFor(() => window.document.querySelectorAll('#songList .song-item').length === 2);
  click(window, '#songList .song-item');
  await waitFor(() => /one/.test(audios[0].src));
  assert.equal(audios[0].paused, false);
  window.SoloPlayerNative.onAction('pause');
  window.SoloPlayerNative.onAction('pause'); // Idempotent.
  assert.equal(audios[0].paused, true);
  window.SoloPlayerNative.onAction('play');
  assert.equal(audios[0].paused, false);
  window.SoloPlayerNative.onAction('next');
  await waitFor(() => /two/.test(audios[0].src));
  window.SoloPlayerNative.onAction('prev');
  await waitFor(() => /one/.test(audios[0].src));
});

// ---- Repeat / track loading ----
const trio = () => ({
  'tree:music/': [dir('album', 'album')],
  'tree:music/album': [song('a', 'a.mp3'), song('b', 'b.mp3'), song('c', 'c.mp3')],
});
const current = audio => (audio.src.match(/(?:blob:|document\/)(\w+)$/) || [])[1];
const label = (window, selector) => window.document.querySelector(`${selector} .repeat-label`).textContent;

async function playFirstOfTrio(options = {}) {
  const env = start({ selected: ['tree:music'], documents: trio(), ...options });
  await new Promise(resolve => setTimeout(resolve, 50));
  click(env.window, '#btnSelectFolder');
  await waitFor(() => env.window.document.querySelectorAll('#songList .song-item').length === 3);
  click(env.window, '#songList .song-item');
  await waitFor(() => current(env.audios[0]) === 'a');
  return env;
}

test('native tracks are read in full and played from a blob URL', async () => {
  const { audios, fetches } = await playFirstOfTrio();
  // Not the local-server URL, whose Range responses ignore the requested offset.
  assert.equal(audios[0].src, 'blob:a');
  assert.match(fetches[0], /_capacitor_content_content:\/\/provider\/document\/a$/);
});

test('falls back to streaming when the full read fails', async () => {
  const { audios } = await playFirstOfTrio({ failFetch: true });
  assert.match(audios[0].src, /_capacitor_content_content:\/\/provider\/document\/a$/);
  assert.equal(audios[0].paused, false);
});

test('repeat all wraps from the last track back to the first', async () => {
  const { window, audios, native } = await playFirstOfTrio();
  const a = audios[0];
  click(window, '#btnRepeatSongs'); // Off -> All
  a.finish(); await waitFor(() => current(a) === 'b');
  a.finish(); await waitFor(() => current(a) === 'c');
  a.finish(); await waitFor(() => current(a) === 'a');
  assert.equal(a.paused, false);
  assert.ok(!window.document.getElementById('miniPauseIcon').classList.contains('hidden'));
  // A natural end must not tell the service "paused" (it would drop the wake lock).
  assert.ok(!native.includes('update:false'));
});

test('repeat off stops after the last track', async () => {
  const { window, audios, native } = await playFirstOfTrio();
  const a = audios[0];
  window.SoloPlayerNative.onAction('next'); await waitFor(() => current(a) === 'b');
  window.SoloPlayerNative.onAction('next'); await waitFor(() => current(a) === 'c');
  a.finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(current(a), 'c');
  assert.equal(a.paused, true);
  assert.ok(!window.document.getElementById('miniPlayIcon').classList.contains('hidden'));
  assert.equal(native[native.length - 1], 'stop');
});

test('repeat one replays on a natural end, but manual next still advances', async () => {
  const { window, audios } = await playFirstOfTrio();
  const a = audios[0];
  click(window, '#btnRepeatSongs');
  click(window, '#btnRepeatSongs'); // Off -> All -> One
  assert.equal(label(window, '#btnRepeatSongs'), 'Repeat One');
  const plays = a.plays;
  a.finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(current(a), 'a');
  assert.equal(a.currentTime, 0);
  assert.ok(a.plays > plays);
  click(window, '#npNext');
  await waitFor(() => current(a) === 'b');
  window.SoloPlayerNative.onAction('next'); // notification / headset
  await waitFor(() => current(a) === 'c');
  window.SoloPlayerNative.onAction('next'); // wraps while repeat is on
  await waitFor(() => current(a) === 'a');
});

test('a track that fails to play is skipped', async () => {
  const { window, audios } = await playFirstOfTrio();
  const a = audios[0];
  a.error = { code: 4, message: 'decode error' };
  a.dispatchEvent(new window.Event('error'));
  await waitFor(() => current(a) === 'b');
});

test('repeat buttons on every screen share one mode, which is saved', async () => {
  const idb = new IDBFactory();
  const { window } = await playFirstOfTrio({ idb });
  const songsBtn = window.document.getElementById('btnRepeatSongs');
  assert.equal(label(window, '#btnRepeatSongs'), 'Repeat Off');
  click(window, '#btnRepeatSongs');
  assert.equal(label(window, '#btnRepeatSongs'), 'Repeat All');
  assert.ok(songsBtn.classList.contains('active'));
  assert.ok(window.document.getElementById('npRepeat').classList.contains('active'));

  click(window, '[data-tab="playlists"]');
  click(window, '#autoPlaylists .playlist-card');
  const detailBtn = '#detailActions .repeat-toggle';
  assert.equal(label(window, detailBtn), 'Repeat All');
  click(window, detailBtn);
  assert.equal(label(window, detailBtn), 'Repeat One');
  assert.equal(label(window, '#btnRepeatSongs'), 'Repeat One');
  assert.ok(!window.document.getElementById('npRepeatOneIcon').classList.contains('hidden'));

  await new Promise(resolve => setTimeout(resolve, 50)); // let the settings write land
  const restarted = start({ selected: [], documents: {}, idb });
  await waitFor(() => label(restarted.window, '#btnRepeatSongs') === 'Repeat One');
});

test('legacy path keeps regular folder and classifies an ambiguous folder URI', async () => {
  const legacy = {
    'file:///Music': [
      { name: 'regular', type: 'directory', uri: 'file:///Music/regular' },
      { name: 'millsage', type: 'file', uri: 'file:///Music/millsage' },
    ],
    'file:///Music/regular': [{ name: 'first.mp3', type: 'file', uri: 'file:///Music/regular/first.mp3' }],
    'file:///Music/millsage': [{ name: 'second.wav', type: 'file', uri: 'file:///Music/millsage/second.wav' }],
  };
  const { window } = start({ selected: [], documents: {}, legacy });
  await waitFor(() => window.document.querySelectorAll('#songList .song-item').length === 2);
  assert.match(window.document.getElementById('autoPlaylists').textContent, /regular/);
  assert.match(window.document.getElementById('autoPlaylists').textContent, /millsage/);
  assert.equal(window.localStorage.getItem('soloplayer:musicPath'), 'Music');
});
