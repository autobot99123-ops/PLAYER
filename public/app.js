'use strict';

/* ============================================================
   Player
   - local video library, click to play
   - optional picture-in-picture popup on tab / app switch
   - software audio boost (gain stage) so quiet output becomes loud
   ============================================================ */

const $ = (s) => document.querySelector(s);

const video = $('#video');
const stage = $('#stage');
const fullBtn = $('#fullBtn');
const listEl = $('#list');
const emptyEl = $('#empty');
const countEl = $('#videoCount');
const folderEl = $('#folderPath');
const searchEl = $('#search');
const seekEl = $('#seek');
const boostEl = $('#boost');
const boostReadout = $('#boostReadout');
const curEl = $('#curTime');
const durEl = $('#durTime');
const toastEl = $('#toast');
const dropEl = $('#drop');
const pipBadge = $('#pipBadge');
const muteBtn = $('#muteBtn');
const playBtn = $('#playBtn');
const pipBtn = $('#pipBtn');
const audioStateEl = $('#audioState');
const autoPipEl = $('#autoPip');
const libBtn = $('#libBtn');
const libPanel = $('#libPanel');
const libBackdrop = $('#libBackdrop');
const libClose = $('#libClose');
const stageIdle = $('#stageIdle');

const SEEK = 10;
const SEEK_FINE = 1;
const BOOST_STEP = 20;          // percent, for the volume buttons and arrow keys
const BOOST_MIN = 100;
const BOOST_MAX = 400;

let library = [];
let currentIndex = -1;
let objectUrl = null;
let toastTimer = null;
let pendingAutoPip = false;

let audioCtx = null;
let gainNode = null;
let analyser = null;
let meterData = null;
let meterRaf = null;
let graphReady = false;

/* ------------------------------------------------------------
   small helpers
   ------------------------------------------------------------ */
function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function toast(msg, ms = 1500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const inPip = () => document.pictureInPictureElement === video;
const libraryIsOpen = () => document.body.classList.contains('lib-open');

function setIcon(btn, id) {
  const use = btn && btn.querySelector('use');
  if (use) use.setAttribute('href', `#${id}`);
}

/* ------------------------------------------------------------
   library overlay
   ------------------------------------------------------------ */
function openLibrary() {
  document.body.classList.add('lib-open');
  libBackdrop.hidden = false;
  libPanel.setAttribute('aria-hidden', 'false');
}

function closeLibrary() {
  document.body.classList.remove('lib-open');
  libBackdrop.hidden = true;
  libPanel.setAttribute('aria-hidden', 'true');
}

/* ------------------------------------------------------------
   audio: boost graph

   video -> compressor -> gain -> analyser -> speakers

   The compressor sits before the gain so heavy boosting distorts
   less. The graph is only built from a real user gesture (a click on
   a video): a media element connected to a MediaElementSource can only
   output through that graph, so a suspended AudioContext means silence.
   ------------------------------------------------------------ */
function ensureAudioGraph() {
  if (graphReady) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;

  try {
    audioCtx = new AC();

    const source = audioCtx.createMediaElementSource(video);

    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = Number(boostEl.value) / 100;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    meterData = new Uint8Array(analyser.frequencyBinCount);

    source.connect(comp);
    comp.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    audioCtx.addEventListener('statechange', () => {
      if (audioCtx.state === 'suspended' && !video.paused) audioCtx.resume().catch(() => {});
    });

    audioCtx.resume().catch(() => {});
    graphReady = true;
    startMeter();
    return true;
  } catch {
    graphReady = false;
    return false;
  }
}

/* ------------------------------------------------------------
   audio

   Default path is the plain, native <video> audio. That always works.

   The Web Audio graph is only built when the user actually asks for
   more than 100%, because a media element connected to a
   MediaElementSource can ONLY be heard through that graph: if the
   AudioContext is ever suspended (Chrome does this in background and
   installed windows) the video goes completely silent, and there is
   no way to detach the source again.

   Drags and clicks are user gestures, so building it there is safe.
   ------------------------------------------------------------ */
function setBoost(percent) {
  const pct = Math.min(BOOST_MAX, Math.max(BOOST_MIN, Math.round(percent)));
  boostEl.value = String(pct);
  boostReadout.textContent = `${pct}%`;

  if (pct > BOOST_MIN) {
    if (ensureAudioGraph() && gainNode) gainNode.gain.value = pct / 100;
  } else if (gainNode) {
    gainNode.gain.value = 1;   // cannot unhook the graph, so just neutralise it
  }
  return pct;
}

/* Watchdog: a suspended graph means silence. Try to wake it, and if it
   will not wake, drop the boost so the native path is used again. */
let resumeFails = 0;
function keepAudioAlive() {
  if (!audioCtx) return;
  if (audioCtx.state === 'running') { resumeFails = 0; return; }
  if (video.paused) return;

  audioCtx.resume().then(() => {
    resumeFails = 0;
    if (audioCtx.state !== 'running') {
      resumeFails++;
      if (resumeFails >= 3) {
        setBoost(BOOST_MIN);
        toast('Boost off — browser blocked extra audio', 2600);
      }
    }
  }).catch(() => {
    resumeFails++;
    if (resumeFails >= 3) {
      setBoost(BOOST_MIN);
      toast('Boost off — browser blocked extra audio', 2600);
    }
  });
}

/* Never leave the element muted. */
function unmute() {
  video.muted = false;
  syncTransportUi();
}

function nudgeBoost(deltaPercent) {
  video.muted = false;
  const pct = setBoost(Number(boostEl.value) + deltaPercent);
  toast(`Boost ${pct}%`, 900);
  syncTransportUi();
}

function toggleMute() {
  video.muted = !video.muted;
  toast(video.muted ? 'Muted' : 'Unmuted', 900);
  syncTransportUi();
}

/* Signal meter, proves the file really carries audio. */
function startMeter() {
  if (meterRaf || !analyser) return;

  const loop = () => {
    analyser.getByteFrequencyData(meterData);
    let peak = 0;
    for (let i = 0; i < meterData.length; i++) if (meterData[i] > peak) peak = meterData[i];

    if (video.muted) {
      audioStateEl.textContent = 'Muted';
      audioStateEl.dataset.level = 'bad';
    } else if (peak > 24) {
      audioStateEl.textContent = `Signal ${peak}`;
      audioStateEl.dataset.level = 'ok';
    } else if (peak > 4) {
      audioStateEl.textContent = `Quiet ${peak}`;
      audioStateEl.dataset.level = 'warn';
    } else {
      audioStateEl.textContent = video.paused ? 'Paused' : 'No signal';
      audioStateEl.dataset.level = 'bad';
    }
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

function syncTransportUi() {
  const playing = !video.paused && !video.ended;
  setIcon(playBtn, playing ? 'i-pause' : 'i-play');
  setIcon(muteBtn, video.muted ? 'i-mute' : 'i-vol');
  pipBtn.classList.toggle('active', inPip());
  pipBadge.hidden = !inPip();
  stageIdle.hidden = Boolean(video.getAttribute('src'));
}

/* ------------------------------------------------------------
   library data
   ------------------------------------------------------------ */
async function loadLibrary() {
  try {
    const res = await fetch('/api/videos', { cache: 'no-store' });
    const data = await res.json();
    library = Array.isArray(data.videos) ? data.videos : [];
    folderEl.textContent = data.exists ? data.dir : `${data.dir} (${data.error || 'missing'})`;
    folderEl.title = data.dir;
  } catch (err) {
    library = [];
    folderEl.textContent = `Scan failed: ${err.message}`;
  }
  renderList();
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const shown = q ? library.filter((v) => v.name.toLowerCase().includes(q)) : library;

  listEl.innerHTML = '';
  countEl.textContent = String(shown.length);
  emptyEl.hidden = shown.length > 0;

  const frag = document.createDocumentFragment();

  shown.forEach((item) => {
    const realIndex = library.indexOf(item);

    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.tabIndex = 0;
    if (realIndex === currentIndex) li.classList.add('active');

    const idx = document.createElement('span');
    idx.className = 'li-index';
    idx.textContent = String(realIndex + 1);

    const text = document.createElement('span');
    text.className = 'li-text';

    const name = document.createElement('div');
    name.className = 'li-name';
    name.textContent = item.name;

    const size = document.createElement('div');
    size.className = 'li-size';
    size.textContent = fmtSize(item.size);

    text.append(name, size);
    li.append(idx, text);

    const open = () => playIndex(realIndex);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    frag.appendChild(li);
  });

  listEl.appendChild(frag);
}

/* ------------------------------------------------------------
   playback
   ------------------------------------------------------------ */
function startPlayback(src, label, index) {
  currentIndex = index;
  unmute();
  setBoost(Number(boostEl.value));   // builds the graph only if boost > 100%

  video.src = src;
  video.play()
    .then(() => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      syncTransportUi();
      toast(`Playing ${label}`);
    })
    .catch((err) => toast(`Cannot play: ${err.message}`, 2600));

  document.title = `${label} — Player`;
  renderList();
  closeLibrary();
}

function playIndex(index) {
  const item = library[index];
  if (!item) return;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  startPlayback(item.url, item.name, index);
}

function playLocalFile(file) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  startPlayback(objectUrl, file.name, -1);
}

function togglePlay() {
  if (!video.getAttribute('src')) { openLibrary(); return; }
  if (video.paused) video.play().catch((err) => toast(err.message, 2200));
  else video.pause();
}

function stopPlayback() {
  video.pause();
  video.currentTime = 0;
  toast('Stopped');
}

function seekBy(delta) {
  if (!Number.isFinite(video.duration)) return;
  const target = Math.min(Math.max(0, video.currentTime + delta), video.duration);
  video.currentTime = target;
  toast(`${delta > 0 ? '+' : '−'}${delta}s → ${fmt(target)}`, 800);
}

function step(delta) {
  if (!library.length) { toast('Library is empty'); return; }
  let next = currentIndex + delta;
  if (next < 0) next = library.length - 1;
  if (next >= library.length) next = 0;
  playIndex(next);
}

async function togglePip() {
  if (!document.pictureInPictureEnabled) { toast('Picture-in-picture not supported', 2400); return; }
  try {
    if (inPip()) {
      await document.exitPictureInPicture();
      toast('Popup closed');
    } else {
      if (!video.getAttribute('src')) { openLibrary(); return; }
      await video.requestPictureInPicture();
      toast('Popup on — switch tabs freely');
    }
  } catch (err) {
    pendingAutoPip = true;
    toast(`Popup blocked (${err.name})`, 2200);
  }
  syncTransportUi();
}

/* ------------------------------------------------------------
   fullscreen

   Chrome refuses requestFullscreen() in plenty of situations
   (installed windows, iframes, missing transient activation), and it
   fails silently. So try the real API first and fall back to a CSS
   fullscreen, which always works and looks identical because the
   video keeps object-fit: contain.
   ------------------------------------------------------------ */
let fsMode = null;   // 'api' | 'css' | null

const isFs = () => Boolean(document.fullscreenElement) || document.body.classList.contains('fakefs');

function enterFullscreen() {
  const done = (mode) => { fsMode = mode; syncFullscreenUi(); };

  const req = stage.requestFullscreen
    || stage.webkitRequestFullscreen
    || stage.msRequestFullscreen;

  if (!req) { document.body.classList.add('fakefs'); done('css'); return; }

  let p;
  try { p = req.call(stage); }
  catch { document.body.classList.add('fakefs'); done('css'); return; }

  if (p && typeof p.then === 'function') {
    p.then(() => done('api')).catch(() => { document.body.classList.add('fakefs'); done('css'); });
  } else {
    done('api');
  }
}

function exitFullscreen() {
  document.body.classList.remove('fakefs');
  if (fsMode === 'api' && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  fsMode = null;
  syncFullscreenUi();
}

function syncFullscreenUi() {
  const on = isFs();
  document.body.classList.toggle('fs', on);
  setIcon(fullBtn, on ? 'i-exitfull' : 'i-full');
  fullBtn.classList.toggle('active', on);
}

function toggleFullscreen() {
  if (isFs()) exitFullscreen();
  else enterFullscreen();
}

/* in CSS fullscreen the usual Esc is the browser's, so add a way out */
stage.addEventListener('dblclick', () => {
  if (document.body.classList.contains('fakefs')) exitFullscreen();
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) fsMode = null;
  syncFullscreenUi();
});

document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement) fsMode = null;
  syncFullscreenUi();
});

/* ------------------------------------------------------------
   popup on tab / app switch
   ------------------------------------------------------------ */
async function autoPopup() {
  if (!autoPipEl.checked) return;
  if (inPip()) return;
  if (!video.getAttribute('src')) return;
  if (video.paused || video.readyState < 3) return;
  if (!document.pictureInPictureEnabled) return;
  if (video.disablePictureInPicture) return;

  try {
    await video.requestPictureInPicture();
    syncTransportUi();
    toast('Popup on', 1200);
  } catch (err) {
    // Chrome needs the document to have had a user gesture first.
    // Remember it and pop up on the very next click or key press.
    pendingAutoPip = true;
    audioStateEl.textContent = `Popup blocked (${err.name})`;
    audioStateEl.dataset.level = 'warn';
  }
}

/* tab switch, app switch, and a couple of retries: Chrome settles the
   visibility change asynchronously, so the first call can be refused. */
let autoPipTimer = null;
function scheduleAutoPopup() {
  if (!autoPipEl.checked) return;
  clearTimeout(autoPipTimer);
  autoPipTimer = setTimeout(autoPopup, 250);
}

document.addEventListener('visibilitychange', () => { if (document.hidden) scheduleAutoPopup(); });
window.addEventListener('blur', scheduleAutoPopup);
window.addEventListener('pagehide', scheduleAutoPopup);
video.addEventListener('playing', scheduleAutoPopup);

video.addEventListener('enterpictureinpicture', syncTransportUi);
video.addEventListener('leavepictureinpicture', syncTransportUi);

['pointerdown', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, async () => {
    if (!pendingAutoPip) return;
    pendingAutoPip = false;
    audioStateEl.textContent = 'Audio on';
    await autoPopup();
  }, { capture: true });
});

/* ------------------------------------------------------------
   keyboard
   ------------------------------------------------------------ */
const ACTIONS = {
  ' ': 'play',
  k: 'play',
  s: 'stop',
  j: 'back',
  l: 'forward',
  arrowleft: 'back',
  arrowright: 'forward',
  arrowup: 'volUp',
  arrowdown: 'volDown',
  m: 'mute',
  o: 'pip',
  f: 'full',
  n: 'next',
  p: 'prev',
  ']': 'next',
  '[': 'prev',
  b: 'library',
  backspace: 'library',
};

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

  if (e.key === 'Escape') {
    if (document.body.classList.contains('fakefs')) { exitFullscreen(); return; }
    if (document.fullscreenElement || inPip()) return;   // the browser handles these
    if (libraryIsOpen()) { closeLibrary(); libBtn.focus(); return; }
  }
  if (typing) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const stepSize = e.shiftKey ? SEEK_FINE : SEEK;

  // digits jump straight to that tenth of the video, numpad included
  const digit = /^[0-9]$/.test(e.key) ? e.key : (/^Numpad[0-9]$/.test(e.code) ? e.code.slice(-1) : null);
  if (digit !== null && Number.isFinite(video.duration)) {
    e.preventDefault();
    video.currentTime = (Number(digit) / 10) * video.duration;
    toast(`${digit * 10}% → ${fmt(video.currentTime)}`, 800);
    return;
  }

  const action = ACTIONS[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();

  switch (action) {
    case 'play': togglePlay(); break;
    case 'stop': stopPlayback(); break;
    case 'back': seekBy(-stepSize); break;
    case 'forward': seekBy(stepSize); break;
    case 'volUp': nudgeBoost(BOOST_STEP); break;
    case 'volDown': nudgeBoost(-BOOST_STEP); break;
    case 'mute': toggleMute(); break;
    case 'pip': togglePip(); break;
    case 'full': toggleFullscreen(); break;
    case 'next': step(1); break;
    case 'prev': step(-1); break;
    case 'library': if (libraryIsOpen()) closeLibrary(); else openLibrary(); break;
  }
});

/* ------------------------------------------------------------
   buttons
   ------------------------------------------------------------ */
document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    switch (btn.dataset.act) {
      case 'play': togglePlay(); break;
      case 'stop': stopPlayback(); break;
      case 'back10': seekBy(-SEEK); break;
      case 'fwd10': seekBy(SEEK); break;
      case 'volUp': nudgeBoost(BOOST_STEP); break;
      case 'volDown': nudgeBoost(-BOOST_STEP); break;
      case 'mute': toggleMute(); break;
case 'pip': togglePip(); break;
      case 'full': toggleFullscreen(); break;
      case 'fsExit': exitFullscreen(); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'library': if (libraryIsOpen()) closeLibrary(); else openLibrary(); break;
    }
  });
});

libBtn.addEventListener('click', () => (libraryIsOpen() ? closeLibrary() : openLibrary()));
libClose.addEventListener('click', () => { closeLibrary(); libBtn.focus(); });
libBackdrop.addEventListener('click', () => { closeLibrary(); libBtn.focus(); });

$('#rescanBtn').addEventListener('click', async () => { await loadLibrary(); toast('Rescanned'); });
$('#openBtn').addEventListener('click', () => $('#fileInput').click());

$('#fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  const pick = files.find((f) => f.type.startsWith('video/')) || files[0];
  if (pick) playLocalFile(pick);
  e.target.value = '';
});

searchEl.addEventListener('input', renderList);
boostEl.addEventListener('input', () => setBoost(Number(boostEl.value)));
autoPipEl.addEventListener('change', () => {
  localStorage.setItem('player.autopip', autoPipEl.checked ? '1' : '0');
  toast(autoPipEl.checked ? 'Auto popup on' : 'Auto popup off');
});

/* ------------------------------------------------------------
   drag & drop
   ------------------------------------------------------------ */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropEl.hidden = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  const files = Array.from(e.dataTransfer.files || []);
  const pick = files.find((f) => f.type.startsWith('video/')) || files[0];
  if (pick) playLocalFile(pick);
});

/* ------------------------------------------------------------
   media wiring
   ------------------------------------------------------------ */
video.addEventListener('loadedmetadata', () => { durEl.textContent = fmt(video.duration); });

video.addEventListener('timeupdate', () => {
  curEl.textContent = fmt(video.currentTime);
  if (Number.isFinite(video.duration) && video.duration > 0 && seekEl.dataset.drag !== '1') {
    seekEl.value = String(Math.round((video.currentTime / video.duration) * 1000));
  }
});

video.addEventListener('play', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  keepAudioAlive();
  syncTransportUi();
});
video.addEventListener('pause', syncTransportUi);
video.addEventListener('volumechange', syncTransportUi);

/* poll while playing: a suspended graph is the one way to lose all sound */
setInterval(() => { if (!video.paused) keepAudioAlive(); }, 1500);

video.addEventListener('error', () => {
  const msg = {
    1: 'loading aborted',
    2: 'network error',
    3: 'decode error — codec not supported',
    4: 'Chrome cannot play this container/codec',
  };
  toast(`Error: ${msg[video.error ? video.error.code : 0] || 'unknown'}`, 3200);
});

seekEl.addEventListener('input', () => { seekEl.dataset.drag = '1'; });
seekEl.addEventListener('change', () => {
  seekEl.dataset.drag = '';
  if (Number.isFinite(video.duration)) video.currentTime = (Number(seekEl.value) / 1000) * video.duration;
});

/* ------------------------------------------------------------
   desktop-app install + offline shell
   ------------------------------------------------------------ */
const installBtn = $('#installBtn');
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  installBtn.hidden = true;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch { /* dismissed */ }
  deferredInstall = null;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  deferredInstall = null;
  toast('Installed — opening it from your desktop now');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  });
}

/* the manifest shortcut opens straight into the library */
if (new URLSearchParams(location.search).get('panel') === 'library') {
  openLibrary();
}

/* Installed app window: drop the folder path, the audio badge and the
   install button, none of which mean anything once it is installed. */
const runningStandalone =
  window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: window-controls-overlay)').matches
  || navigator.standalone === true;

if (runningStandalone) {
  document.body.classList.add('installed');
  installBtn.hidden = true;
}

/* ------------------------------------------------------------
   boot
   ------------------------------------------------------------ */
video.volume = 1;
video.muted = false;
setBoost(Number(boostEl.value));
video.disablePictureInPicture = false;
autoPipEl.checked = localStorage.getItem('player.autopip') !== '0';
syncTransportUi();
loadLibrary();
