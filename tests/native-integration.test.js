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

function start({ selected, documents, legacy } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const releases = [];
  const alerts = [];
  const audios = [];
  class Audio extends window.EventTarget {
    constructor() { super(); this.paused = true; this.duration = 60; this.currentTime = 0; audios.push(this); }
    set src(value) { this._src = value; queueMicrotask(() => this.onloadedmetadata?.()); }
    get src() { return this._src; }
    removeAttribute() { this._src = ''; }
    load() {}
    play() { this.paused = false; this.dispatchEvent(new window.Event('play')); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new window.Event('pause')); }
  }
  window.Audio = Audio;
  window.indexedDB = new IDBFactory();
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
  window.AndroidPlayback = { start() {}, update() {}, stop() {} };
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
  return { window, dom, releases, alerts, audios };
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
  assert.equal(audios[0].paused, false);
  assert.match(audios[0].src, /one/);
  window.SoloPlayerNative.onAction('pause');
  window.SoloPlayerNative.onAction('pause'); // Idempotent.
  assert.equal(audios[0].paused, true);
  window.SoloPlayerNative.onAction('play');
  assert.equal(audios[0].paused, false);
  window.SoloPlayerNative.onAction('next');
  assert.match(audios[0].src, /two/);
  window.SoloPlayerNative.onAction('prev');
  assert.match(audios[0].src, /one/);
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
