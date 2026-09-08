(function () {
  'use strict';

  const root = document.getElementById('jazzradio-app');
  if (!root) return;

  const GLOBAL_KEY = '__BookOasisJazzRadioPlayer';
  const ENGINE_VERSION = '1.6.1';
  const STORAGE_STATION = 'jazzradio.station';
  const STORAGE_VOLUME = 'jazzradio.volume';
  const STORAGE_FLOAT_POS = 'jazzradio.float.position';
  const STORAGE_VISUALIZER_MODE = 'jazzradio.visualizer.mode';
  const VISUALIZER_MODES = ['spectrum', 'mirror', 'line', 'wave', 'tube', 'ribbon', 'constellation'];
  const VISUALIZER_LABELS = {
    spectrum: 'LIVE SPECTRUM',
    mirror: 'MIRROR BARS',
    line: 'LINE SPECTRUM',
    wave: 'WAVEFORM',
    tube: 'VINTAGE AMP',
    ribbon: 'AMBER RIBBON',
    constellation: 'JAZZ CONSTELLATION',
  };
  const DATA_URL = '/api/media/dashboard/widgets/jazzradio/data?type=general';
  const METADATA_POLL_MS = 12000;

  function storageGet(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (_) { /* ignore restricted storage */ }
  }

  function normalizeVisualizerMode(value) {
    const mode = String(value || '').toLowerCase();
    return VISUALIZER_MODES.includes(mode) ? mode : 'spectrum';
  }

  function visualizerModeLabel(mode) {
    return VISUALIZER_LABELS[normalizeVisualizerMode(mode)] || VISUALIZER_LABELS.spectrum;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function isIOSDevice() {
    const ua = navigator.userAgent || '';
    const classicIOS = /iPad|iPhone|iPod/.test(ua);
    const iPadDesktopMode = navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
    return classicIOS || iPadDesktopMode;
  }

  function iosVolumeText() {
    return window.matchMedia && window.matchMedia('(max-width: 540px)').matches
      ? '기기 볼륨'
      : '기기 볼륨 버튼으로 조절';
  }

  function createEngine() {
    let audio = document.getElementById('jazzradio-global-audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'jazzradio-global-audio';
      audio.preload = 'none';
      audio.playsInline = true;
      audio.crossOrigin = 'anonymous';
      audio.style.display = 'none';
      document.body.appendChild(audio);
    } else {
      audio.crossOrigin = 'anonymous';
    }

    let style = document.getElementById('jazzradio-global-player-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'jazzradio-global-player-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      #jazzradio-float-player .jrfp-disc{padding:0;border:0;color:inherit;cursor:pointer}
      #jazzradio-float-player .jrfp-disc[aria-pressed="true"]{box-shadow:0 0 0 2px #eac482,0 0 12px #eac48255}
      #jazzradio-float-player .jrfp-disc:focus-visible{outline:2px solid white;outline-offset:3px}
      #jazzradio-float-player .jrfp-noise{display:flex;align-items:center;gap:8px;padding:0 12px 12px;color:#eac482;font-size:11px}
      #jazzradio-float-player .jrfp-noise input{flex:1;min-width:0;accent-color:#eac482}
      #jazzradio-float-player .jrfp-noise[hidden],#jazzradio-float-player.jrfp-collapsed .jrfp-noise{display:none!important}

      #jazzradio-float-player .jrfp-viz{position:relative}
      #jazzradio-float-player [data-jazzradio-power]{position:absolute;left:7.05%;top:51.2%;width:4.7%;height:30%;min-width:24px;min-height:24px;transform:translate(-50%,-50%);background:transparent;border:0;cursor:pointer;padding:0}
      #jazzradio-float-player [data-jazzradio-power][hidden]{display:none!important}
      #jazzradio-float-player [data-jazzradio-power]:focus-visible{outline:2px solid #fff;outline-offset:2px}

      #jazzradio-float-player{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));width:360px;max-width:calc(100vw - 24px);z-index:999998;color:var(--app-text-primary,#f1f1f6);font-family:inherit;background:linear-gradient(145deg,rgba(21,22,32,.98),rgba(13,14,22,.98));border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.42);overflow:hidden;backdrop-filter:blur(16px);transition:width .2s ease,max-width .2s ease,height .2s ease,border-radius .2s ease}
      #jazzradio-float-player[hidden]{display:none!important}
      #jazzradio-float-player .jrfp-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px 7px 12px;background:rgba(255,255,255,.035);border-bottom:1px solid rgba(255,255,255,.06);font-size:12px;font-weight:800}
      #jazzradio-float-player .jrfp-brand{display:flex;align-items:center;gap:7px}#jazzradio-float-player .jrfp-dot{width:7px;height:7px;border-radius:50%;background:#ff5368;box-shadow:0 0 0 4px rgba(255,83,104,.12)}
      #jazzradio-float-player .jrfp-actions{display:flex;align-items:center;gap:2px}#jazzradio-float-player .jrfp-drag,#jazzradio-float-player .jazzradio-float-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:14px}
      #jazzradio-float-player .jrfp-drag{cursor:grab;touch-action:none}#jazzradio-float-player .jrfp-drag:active{cursor:grabbing;background:rgba(255,255,255,.08)}#jazzradio-float-player .jazzradio-float-close:hover{color:#ff7a89;background:rgba(255,80,100,.08)}
      #jazzradio-float-player .jrfp-viz{box-sizing:border-box;height:80px;padding:0;background:linear-gradient(180deg,rgba(121,87,255,.08),transparent);cursor:pointer;touch-action:manipulation}#jazzradio-float-player .jrfp-viz:focus-visible{outline:1px solid rgba(139,92,246,.75);outline-offset:-2px}#jazzradio-float-player .jrfp-viz canvas{display:block;width:100%;height:100%;pointer-events:none}
      #jazzradio-float-player .jrfp-body{display:flex;align-items:center;gap:10px;padding:10px 12px 12px}#jazzradio-float-player .jrfp-cover{position:relative;flex:0 0 56px;width:56px;height:56px;border-radius:10px;overflow:hidden;background:rgba(121,87,255,.18)}
      #jazzradio-float-player .jrfp-cover img{width:100%;height:100%;object-fit:cover;display:block}#jazzradio-float-player .jrfp-cover img[hidden]{display:none!important}#jazzradio-float-player .jrfp-cover-placeholder{display:grid;place-items:center;width:100%;height:100%;font-size:21px;background:linear-gradient(145deg,rgba(123,89,255,.35),rgba(56,45,92,.58))}#jazzradio-float-player .jrfp-cover-placeholder[hidden]{display:none!important}
      #jazzradio-float-player .jrfp-meta{min-width:0;flex:1 1 auto}#jazzradio-float-player .jrfp-artist{font-size:13px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#jazzradio-float-player .jrfp-title{margin-top:2px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.82}#jazzradio-float-player .jrfp-station{margin-top:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.5}
      #jazzradio-float-player .jrfp-transport{display:flex;align-items:center;gap:7px;flex:0 0 auto}#jazzradio-float-player .jrfp-disc{display:grid;place-items:center;width:38px;height:38px;flex-shrink:0;box-sizing:border-box;border-radius:50%;font-size:18px;background:radial-gradient(circle,rgba(12,12,18,.95) 0 14%,rgba(121,87,255,.65) 15% 23%,rgba(45,37,72,.95) 24% 65%,rgba(121,87,255,.3) 66% 100%)}#jazzradio-float-player .jrfp-disc.playing i{animation:jazzradio-global-spin 2.8s linear infinite}
      #jazzradio-float-player .jrfp-play{display:grid;place-items:center;flex-shrink:0;box-sizing:border-box;padding:0;width:38px;height:38px;border:0;border-radius:50%;background:#7957ff;color:#fff;cursor:pointer;font-size:13px;box-shadow:0 6px 18px rgba(121,87,255,.3)}
      #jazzradio-float-player .jrfp-volume{display:flex;align-items:center;gap:8px;padding:0 12px 10px;font-size:11px;opacity:.78}#jazzradio-float-player .jrfp-volume input{min-width:0;flex:1 1 auto;accent-color:#7957ff}#jazzradio-float-player .jrfp-volume-value{width:35px;text-align:right;font-size:10px}#jazzradio-float-player .jrfp-volume-note{width:auto!important;white-space:nowrap;font-weight:700}
      #jazzradio-float-player .jrfp-collapse,#jazzradio-float-player .jrfp-peek{display:none;place-items:center;border:0;background:transparent;color:inherit;cursor:pointer;touch-action:manipulation}
      @keyframes jazzradio-global-spin{to{transform:rotate(360deg)}}
      @media(max-width:540px){#jazzradio-float-player{width:calc(100vw - 20px);max-width:calc(100vw - 20px);right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px))}#jazzradio-float-player .jrfp-collapse{display:grid;width:30px;height:30px;border-radius:8px;font-size:13px}#jazzradio-float-player .jrfp-collapse:active{background:rgba(255,255,255,.08)}#jazzradio-float-player.jrfp-collapsed{width:44px!important;max-width:44px!important;height:56px!important;min-height:56px;border-radius:14px 0 0 14px;overflow:hidden}#jazzradio-float-player.jrfp-collapsed .jrfp-header,#jazzradio-float-player.jrfp-collapsed .jrfp-viz,#jazzradio-float-player.jrfp-collapsed .jrfp-body,#jazzradio-float-player.jrfp-collapsed .jrfp-volume{display:none!important}#jazzradio-float-player.jrfp-collapsed .jrfp-peek{display:grid;width:44px;height:56px;background:linear-gradient(145deg,rgba(121,87,255,.78),rgba(45,37,72,.96));font-size:15px}#jazzradio-float-player.jrfp-collapsed .jrfp-peek:active{background:rgba(121,87,255,.9)}#jazzradio-float-player .jrfp-body{gap:8px;padding:9px 10px 10px}#jazzradio-float-player .jrfp-cover{flex-basis:52px;width:52px;height:52px}#jazzradio-float-player .jrfp-disc{width:36px;height:36px}#jazzradio-float-player .jrfp-play{width:36px;height:36px}#jazzradio-float-player .jrfp-volume{padding:0 10px 9px}}
    `;

    let floatRoot = document.getElementById('jazzradio-float-player');
    if (!floatRoot) {
      floatRoot = document.createElement('div');
      floatRoot.id = 'jazzradio-float-player';
      floatRoot.hidden = true;
      floatRoot.innerHTML = `
        <div class="jrfp-header">
          <div class="jrfp-brand"><span class="jrfp-dot"></span><span>Jazz Radio</span></div>
          <div class="jrfp-actions">
            <button type="button" class="jrfp-collapse" title="옆으로 숨기기" aria-label="플레이어 옆으로 숨기기" aria-expanded="true"><i class="fa-solid fa-chevron-right"></i></button>
            <button type="button" class="jrfp-drag" title="플레이어 이동" aria-label="플레이어 이동"><i class="fa-solid fa-up-down-left-right"></i></button>
            <button type="button" class="jazzradio-float-close" title="재생 종료" aria-label="재생 종료"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
        <div class="jrfp-viz" role="group" tabindex="0" title="비주얼라이저 모드 변경" aria-label="비주얼라이저 모드 변경"><canvas data-jazzradio-visualizer="float" aria-hidden="true"></canvas><button type="button" data-jazzradio-power aria-label="라디오 재생" aria-pressed="false" hidden></button></div>
        <div class="jrfp-body">
          <div class="jrfp-cover"><img class="jrfp-cover-img" alt="" referrerpolicy="no-referrer" hidden><div class="jrfp-cover-placeholder"><i class="fa-solid fa-music"></i></div></div>
          <div class="jrfp-meta"><div class="jrfp-artist">Jazz Radio</div><div class="jrfp-title">재생 대기 중</div><div class="jrfp-station"></div></div>
          <div class="jrfp-transport"><button type="button" class="jrfp-disc" aria-label="LP 노이즈" aria-pressed="false"><i class="fa-solid fa-compact-disc" aria-hidden="true"></i></button><button type="button" class="jrfp-play" aria-label="재생"><i class="fa-solid fa-play"></i></button></div>
        </div>
        <div class="jrfp-volume"><i class="fa-solid fa-volume-low"></i><input class="jrfp-volume-range" type="range" min="0" max="100" step="1" value="70" aria-label="볼륨"><span class="jrfp-volume-value">70%</span><span class="jrfp-volume-note" hidden></span></div>
        <label class="jrfp-noise" hidden>LP 노이즈 강도 <input type="range" min="0" max="100" step="1" value="30" aria-label="LP 노이즈 강도"><output>30%</output></label>
        <button type="button" class="jrfp-peek" title="플레이어 펼치기" aria-label="플레이어 펼치기"><i class="fa-solid fa-chevron-left"></i></button>
      `;
      document.body.appendChild(floatRoot);
    }
    if (!floatRoot.querySelector('.jrfp-collapse')) {
      const actions = floatRoot.querySelector('.jrfp-actions');
      if (actions) actions.insertAdjacentHTML('afterbegin', '<button type="button" class="jrfp-collapse" title="옆으로 숨기기" aria-label="플레이어 옆으로 숨기기" aria-expanded="true"><i class="fa-solid fa-chevron-right"></i></button>');
    }
    if (!floatRoot.querySelector('.jrfp-peek')) {
      floatRoot.insertAdjacentHTML('beforeend', '<button type="button" class="jrfp-peek" title="플레이어 펼치기" aria-label="플레이어 펼치기"><i class="fa-solid fa-chevron-left"></i></button>');
    }

    const state = {
      stations: [],
      selectedStation: null,
      nowPlaying: null,
      sessionStarted: false,
      waiting: false,
      error: '',
      volume: 70,
      noiseEnabled: storageGet('jazzradio.noise.enabled', 'false') === 'true',
      noiseControlsVisible: false,
      noiseLevel: Math.max(0, Math.min(100, Number(storageGet('jazzradio.noise.level', '30')) || 0)),
      visualizerMode: normalizeVisualizerMode(storageGet(STORAGE_VISUALIZER_MODE, 'spectrum')),
    };

    const viewBindings = new Set();
    let pollBusy = false;
    let audioContext = null;
    let mediaSource = null;
    let noiseSource = null;
    let noiseControlsTimer = null;
    let noiseGain = null;
    let analyser = null;
    let frequencyData = null;
    let timeData = null;
    let visualizerFrame = 0;
    let frameId = 0;
    let disposed = false;
    let playRevision = 0;
    let metadataRequest = null;
    let splitter = null;
    let merger = null;
    let channelAnalysers = [];
    let channelData = [];
    let silentSince = 0;
    let analysisStatus = 'idle';
    const listeners = [];
    const tubeImage = new Image();
    tubeImage.onload = () => scheduleVisualizers();
    tubeImage.src = root.querySelector('[data-jazzradio-tube-image]').src;

    function listen(target, event, handler, options) {
      target.addEventListener(event, handler, options);
      listeners.push(() => target.removeEventListener(event, handler, options));
    }

    const floatEls = {
      play: floatRoot.querySelector('.jrfp-play'),
      disc: floatRoot.querySelector('.jrfp-disc'),
      artist: floatRoot.querySelector('.jrfp-artist'),
      title: floatRoot.querySelector('.jrfp-title'),
      station: floatRoot.querySelector('.jrfp-station'),
      cover: floatRoot.querySelector('.jrfp-cover-img'),
      coverPlaceholder: floatRoot.querySelector('.jrfp-cover-placeholder'),
      volume: floatRoot.querySelector('.jrfp-volume-range'),
      volumeValue: floatRoot.querySelector('.jrfp-volume-value'),
      volumeNote: floatRoot.querySelector('.jrfp-volume-note'),
      volumeWrap: floatRoot.querySelector('.jrfp-volume'),
      close: floatRoot.querySelector('.jazzradio-float-close'),
      collapse: floatRoot.querySelector('.jrfp-collapse'),
      peek: floatRoot.querySelector('.jrfp-peek'),
      drag: floatRoot.querySelector('.jrfp-drag'),
      viz: floatRoot.querySelector('.jrfp-viz'),
    };

    function currentPlaying() {
      return state.sessionStarted && !audio.paused && !audio.ended && audio.readyState >= 3 && !state.waiting && !state.error;
    }

    function snapshot() {
      return {
        stations: state.stations.slice(),
        selectedStation: state.selectedStation,
        nowPlaying: state.nowPlaying,
        sessionStarted: state.sessionStarted,
        waiting: state.waiting,
        error: state.error,
        playing: currentPlaying(),
        volume: state.volume,
        noiseEnabled: state.noiseEnabled,
        noiseControlsVisible: state.noiseControlsVisible,
        noiseLevel: state.noiseLevel,
        visualizerMode: state.visualizerMode,
        analysisStatus,
      };
    }

    function applyArtwork(img, placeholder, url, alt) {
      const src = String(url || '');
      if (!src || img.dataset.failedUrl === src) {
        img.hidden = true;
        placeholder.hidden = false;
        if (!src) img.removeAttribute('src');
        return;
      }
      if (img.getAttribute('src') !== src) {
        img.hidden = true;
        placeholder.hidden = false;
        img.dataset.failedUrl = '';
        img.alt = alt || '앨범 커버';
        img.src = src;
        return;
      }
      if (img.complete && img.naturalWidth > 0) {
        img.hidden = false;
        placeholder.hidden = true;
      }
    }

    listen(floatEls.cover, 'load', () => {
      floatEls.cover.hidden = false;
      floatEls.coverPlaceholder.hidden = true;
    });
    listen(floatEls.cover, 'error', () => {
      floatEls.cover.dataset.failedUrl = floatEls.cover.getAttribute('src') || '';
      floatEls.cover.hidden = true;
      floatEls.coverPlaceholder.hidden = false;
    });

    function viewIsVisible(binding) {
      if (!binding.root || !binding.root.isConnected) return false;
      try { return binding.root.getClientRects().length > 0; } catch (_) { return true; }
    }

    function hasVisibleJazzView() {
      let visible = false;
      Array.from(viewBindings).forEach((binding) => {
        if (!binding.root || !binding.root.isConnected) viewBindings.delete(binding);
        else if (viewIsVisible(binding)) visible = true;
      });
      return visible;
    }

    function syncFloatVisibility() {
      const shouldShow = state.sessionStarted && !hasVisibleJazzView();
      const changed = floatRoot.hidden === shouldShow;
      floatRoot.hidden = !shouldShow;
      if (changed) scheduleVisualizers();
      if (shouldShow && !floatCollapsed) restoreOrClampFloatPosition();
    }

    function renderFloat() {
      const station = state.selectedStation;
      const np = state.nowPlaying;
      const playing = currentPlaying();
      floatEls.play.innerHTML = playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
      floatEls.play.setAttribute('aria-label', playing ? '일시정지' : '재생');
      floatEls.disc.classList.toggle('playing', playing);
      floatEls.disc.setAttribute('aria-pressed', String(state.noiseEnabled));
      floatEls.disc.title = state.noiseEnabled ? 'LP 노이즈 끄기' : 'LP 노이즈 켜기';
      const noiseControls = floatRoot.querySelector('.jrfp-noise');
      noiseControls.hidden = !state.noiseEnabled || !state.noiseControlsVisible;
      noiseControls.querySelector('input').value = String(state.noiseLevel);
      noiseControls.querySelector('output').textContent = `${state.noiseLevel}%`;
      floatEls.viz.dataset.mode = state.visualizerMode;
      const power = floatRoot.querySelector('[data-jazzradio-power]');
      power.hidden = state.visualizerMode !== 'tube';
      power.disabled = !station;
      power.setAttribute('aria-pressed', String(playing));
      power.setAttribute('aria-label', playing ? '라디오 일시정지' : '라디오 재생');
      floatEls.artist.textContent = np && np.available === true ? (np.artist || (station && station.name) || 'Jazz Radio') : ((station && station.name) || 'Jazz Radio');
      floatEls.title.textContent = np && np.available === true ? (np.title || np.raw || '곡명 정보 없음') : (state.waiting ? '곡 정보 불러오는 중…' : '재생 중인 곡 정보가 없습니다.');
      floatEls.station.textContent = station ? `${station.name} · ${station.quality || ''}` : '';
      applyArtwork(floatEls.cover, floatEls.coverPlaceholder, np && np.album_art, np && np.artist ? `${np.artist} 앨범 커버` : '앨범 커버');
      if (isIOSDevice()) {
        floatEls.volumeWrap.classList.add('is-ios');
        floatEls.volume.hidden = true;
        floatEls.volumeValue.hidden = true;
        floatEls.volumeNote.hidden = false;
        floatEls.volumeNote.textContent = iosVolumeText();
      } else {
        floatEls.volumeWrap.classList.remove('is-ios');
        floatEls.volume.hidden = false;
        floatEls.volumeValue.hidden = false;
        floatEls.volumeNote.hidden = true;
        floatEls.volume.value = String(state.volume);
        floatEls.volumeValue.textContent = `${state.volume}%`;
      }
      syncFloatVisibility();
    }

    function emit() {
      syncNoise();
      const snap = snapshot();
      Array.from(viewBindings).forEach((binding) => {
        if (!binding.root || !binding.root.isConnected) viewBindings.delete(binding);
        else {
          try { binding.render(snap); } catch (error) { console.warn('[jazzradio] view render failed:', error); }
        }
      });
      renderFloat();
      scheduleVisualizers();
    }

    function stopNoise() {
      if (noiseSource) { noiseSource.stop(); noiseSource.disconnect(); noiseSource = null; }
      if (noiseGain) { noiseGain.disconnect(); noiseGain = null; }
    }

    function syncNoise() {
      const volume = isIOSDevice() ? 1 : state.volume / 100;
      if (disposed || !state.noiseEnabled || !state.noiseLevel || !volume || !currentPlaying() || !audioContext || audioContext.state !== 'running') {
        stopNoise();
        return;
      }
      try {
        if (!noiseSource) {
          // ponytail: 20-second random texture repeats; use streamed synthesis if repetition becomes noticeable.
          const buffer = audioContext.createBuffer(1, audioContext.sampleRate * 20, audioContext.sampleRate);
          const samples = buffer.getChannelData(0);
          let hiss = 0;
          let crack = 0;
          for (let i = 0; i < samples.length; i++) {
            hiss = hiss * .7 + (Math.random() * 2 - 1) * .024;
            if (Math.random() < 3 / audioContext.sampleRate) crack = (Math.random() * 2 - 1) * .8;
            samples[i] = hiss + crack;
            crack *= .88;
          }
          noiseGain = audioContext.createGain();
          noiseGain.gain.value = 0;
          noiseGain.connect(audioContext.destination);
          noiseSource = audioContext.createBufferSource();
          noiseSource.buffer = buffer;
          noiseSource.loop = true;
          noiseSource.connect(noiseGain);
          noiseSource.start(0, Math.random() * buffer.duration);
        }
        noiseGain.gain.setTargetAtTime(state.noiseLevel / 100 * volume * .12, audioContext.currentTime, .025);
      } catch (error) {
        stopNoise();
        state.noiseEnabled = false;
        storageSet('jazzradio.noise.enabled', false);
        console.warn('[jazzradio] LP noise unavailable:', error);
      }
    }

    function refreshNoiseControls() {
      window.clearTimeout(noiseControlsTimer);
      noiseControlsTimer = null;
      state.noiseControlsVisible = state.noiseEnabled;
      if (state.noiseEnabled) {
        noiseControlsTimer = window.setTimeout(() => {
          noiseControlsTimer = null;
          state.noiseControlsVisible = false;
          emit();
        }, 10000);
      }
    }

    function toggleNoise() {
      state.noiseEnabled = !state.noiseEnabled;
      if (state.noiseEnabled) prepareVisualizerFromGesture();
      storageSet('jazzradio.noise.enabled', state.noiseEnabled);
      refreshNoiseControls();
      emit();
    }

    function setNoiseLevel(raw) {
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      state.noiseLevel = Math.max(0, Math.min(100, Math.round(value)));
      storageSet('jazzradio.noise.level', state.noiseLevel);
      refreshNoiseControls();
      emit();
    }

    function setVolume(raw) {
      let value = Number(raw);
      if (!Number.isFinite(value)) value = 70;
      value = Math.max(0, Math.min(100, Math.round(value)));
      state.volume = value;
      if (!isIOSDevice()) {
        audio.volume = value / 100;
        storageSet(STORAGE_VOLUME, value);
      }
      emit();
    }

    function setVisualizerMode(rawMode) {
      const mode = normalizeVisualizerMode(rawMode);
      if (state.visualizerMode === mode) return;
      state.visualizerMode = mode;
      storageSet(STORAGE_VISUALIZER_MODE, mode);
      emit();
    }

    function cycleVisualizerMode() {
      const current = VISUALIZER_MODES.indexOf(state.visualizerMode);
      const next = VISUALIZER_MODES[(current + 1) % VISUALIZER_MODES.length];
      setVisualizerMode(next);
      return next;
    }

    function setStations(stations) {
      if (!Array.isArray(stations) || !stations.length) return;
      state.stations = stations.slice();
      if (state.selectedStation) {
        const fresh = state.stations.find((item) => item.id === state.selectedStation.id);
        if (fresh) state.selectedStation = fresh;
      }
      if (!state.selectedStation) {
        const wanted = storageGet(STORAGE_STATION, state.stations[0].id);
        state.selectedStation = state.stations.find((item) => item.id === wanted) || state.stations[0];
      }
      emit();
    }

    function setSourceForStation(station) {
      if (!station) return;
      const expected = new URL(station.stream_url, window.location.href).href;
      if (audio.src === expected) return;
      audio.pause();
      audio.src = station.stream_url;
      audio.load();
    }

    async function refreshNowPlaying() {
      const station = state.selectedStation;
      if (!currentPlaying() || !station || pollBusy || disposed) return;
      pollBusy = true;
      const request = new AbortController();
      metadataRequest = request;
      const timeout = window.setTimeout(() => request.abort(), 10000);
      try {
        const url = `${DATA_URL}&station=${encodeURIComponent(station.id)}`;
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (disposed || request.signal.aborted || !state.sessionStarted || state.selectedStation.id !== station.id) return;
        const np = data && data.now_playing;
        state.nowPlaying = np && np.station_id === station.id && np.available === true ? np : null;
        emit();
      } catch (error) {
        if (error.name !== 'AbortError') console.warn('[jazzradio] now playing load failed:', error);
      } finally {
        window.clearTimeout(timeout);
        if (metadataRequest === request) { metadataRequest = null; pollBusy = false; }
      }
    }

    function cancelMetadata() {
      if (metadataRequest) metadataRequest.abort();
      metadataRequest = null;
      pollBusy = false;
    }

    function resumeAudioContext() {
      if (audioContext && audioContext.state !== 'running' && audioContext.state !== 'closed') {
        audioContext.resume().catch(error => console.warn('[jazzradio] AudioContext resume failed:', error));
      }
    }

    function prepareVisualizerFromGesture() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return false;
      }
      try {
        // Safari/iOS requires AudioContext creation/resume and MediaElementSource wiring
        // to happen synchronously inside the user's play/tap gesture.
        if (!audioContext) {
          audioContext = new AudioContextClass();
          listen(audioContext, 'statechange', () => {
            syncNoise();
            scheduleVisualizers();
          });
        }
        resumeAudioContext();
        if (!mediaSource) {
          mediaSource = audioContext.createMediaElementSource(audio);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.82;
          analyser.minDecibels = -90;
          analyser.maxDecibels = -15;
          analyser.channelCount = 2;
          analyser.channelCountMode = 'explicit';
          analyser.channelInterpretation = 'speakers';
          splitter = audioContext.createChannelSplitter(2);
          merger = audioContext.createChannelMerger(2);
          channelAnalysers = [audioContext.createAnalyser(), audioContext.createAnalyser()];
          channelData = channelAnalysers.map(node => {
            node.fftSize = 1024;
            return new Uint8Array(node.fftSize);
          });
          // Upmix mono streams before splitting so both speakers keep their audio.
          mediaSource.connect(analyser);
          analyser.connect(splitter);
          channelAnalysers.forEach((node, i) => {
            splitter.connect(node, i);
            node.connect(merger, 0, i);
          });
          merger.connect(audioContext.destination);
          frequencyData = new Uint8Array(analyser.frequencyBinCount);
          timeData = new Uint8Array(analyser.fftSize);
        }
        return true;
      } catch (error) {
        console.warn('[jazzradio] real visualizer unavailable; using fallback:', error);
        return false;
      }
    }

    async function play() {
      const station = state.selectedStation;
      if (!station) return;
      const revision = ++playRevision;
      state.sessionStarted = true;
      silentSince = 0;
      state.error = '';
      state.waiting = true;
      storageSet(STORAGE_STATION, station.id);
      setSourceForStation(station);
      prepareVisualizerFromGesture();
      emit();
      refreshNowPlaying();
      try {
        await audio.play();
        if (disposed || revision !== playRevision) return;
        state.waiting = false;
        emit();
      } catch (error) {
        if (disposed || revision !== playRevision) return;
        state.waiting = false;
        state.error = '재생을 시작하지 못했습니다. 다시 한 번 재생 버튼을 눌러 주세요.';
        console.warn('[jazzradio] play failed:', error);
        emit();
      }
    }

    function pause() {
      playRevision += 1;
      cancelMetadata();
      audio.pause();
    }

    function toggle() {
      if (!state.selectedStation) return;
      if (audio.paused) play();
      else pause();
    }

    function stop() {
      playRevision += 1;
      cancelMetadata();
      setFloatCollapsed(false);
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch (_) { /* ignore */ }
      state.sessionStarted = false;
      state.waiting = false;
      state.error = '';
      state.nowPlaying = null;
      emit();
    }

    function selectStation(stationId, autoplay) {
      const station = state.stations.find((item) => item.id === stationId) || state.stations[0];
      if (!station) return;
      const changed = !state.selectedStation || state.selectedStation.id !== station.id;
      state.selectedStation = station;
      storageSet(STORAGE_STATION, station.id);
      if (changed) { cancelMetadata(); state.nowPlaying = null; }
      state.error = '';
      emit();
      if (autoplay) play();
    }

    listen(audio, 'ended', () => emit());
    listen(audio, 'volumechange', () => { if (!isIOSDevice()) state.volume = audio.volume * 100; emit(); });
    listen(audio, 'play', () => { emit(); });
    listen(audio, 'pause', () => { state.waiting = false; emit(); });
    listen(audio, 'playing', () => { resumeAudioContext(); state.waiting = false; state.error = ''; emit(); refreshNowPlaying(); });
    listen(audio, 'waiting', () => { if (state.sessionStarted) { state.waiting = true; emit(); } });
    listen(audio, 'error', () => {
      if (!state.sessionStarted) return;
      state.waiting = false;
      state.error = '방송 스트림에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      emit();
    });

    listen(floatEls.disc, 'click', toggleNoise);
    listen(floatRoot.querySelector('.jrfp-noise input'), 'input', event => setNoiseLevel(event.target.value));
    listen(floatEls.play, 'click', toggle);
    listen(floatEls.close, 'click', stop);
    listen(floatEls.volume, 'input', () => setVolume(floatEls.volume.value));
    const floatViz = floatEls.viz;
    if (floatViz) {
      listen(floatViz, 'click', event => {
        if (event.target.closest('[data-jazzradio-power]')) toggle();
        else cycleVisualizerMode();
      });
      listen(floatViz, 'keydown', (event) => {
        if (event.target.tagName === 'BUTTON') return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          cycleVisualizerMode();
        }
      });
    }

    function viewportSize() {
      const vv = window.visualViewport;
      return { width: vv ? vv.width : window.innerWidth, height: vv ? vv.height : window.innerHeight };
    }

    let floatCollapsed = false;
    let floatExpandedPosition = null;

    function isPhoneViewport() {
      return viewportSize().width <= 540;
    }

    function setFloatCollapsed(collapsed) {
      const next = Boolean(collapsed);
      if (next && !isPhoneViewport()) return;
      if (next === floatCollapsed) return;

      if (next) {
        const rect = floatRoot.getBoundingClientRect();
        const viewport = viewportSize();
        floatExpandedPosition = {
          left: floatRoot.style.left, right: floatRoot.style.right,
          top: floatRoot.style.top, bottom: floatRoot.style.bottom,
        };
        const maxTop = Math.max(4, viewport.height - 60);
        floatRoot.style.left = 'auto';
        floatRoot.style.right = 'calc(8px + env(safe-area-inset-right, 0px))';
        floatRoot.style.bottom = 'auto';
        floatRoot.style.top = `${Math.min(Math.max(4, rect.top), maxTop)}px`;
      } else if (floatExpandedPosition) {
        floatRoot.style.left = floatExpandedPosition.left;
        floatRoot.style.right = floatExpandedPosition.right;
        floatRoot.style.top = floatExpandedPosition.top;
        floatRoot.style.bottom = floatExpandedPosition.bottom;
        floatExpandedPosition = null;
      }

      floatCollapsed = next;
      floatRoot.classList.toggle('jrfp-collapsed', next);
      floatEls.collapse.setAttribute('aria-expanded', String(!next));
    }

    listen(floatEls.collapse, 'click', () => setFloatCollapsed(true));
    listen(floatEls.peek, 'click', () => setFloatCollapsed(false));

    function clampFloat(left, top) {
      const viewport = viewportSize();
      const maxX = Math.max(4, viewport.width - floatRoot.offsetWidth - 4);
      const maxY = Math.max(4, viewport.height - floatRoot.offsetHeight - 4);
      return {
        left: Math.min(Math.max(4, left), maxX),
        top: Math.min(Math.max(4, top), maxY),
      };
    }

    function persistFloatPosition(left, top) {
      storageSet(STORAGE_FLOAT_POS, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
    }

    function restoreOrClampFloatPosition() {
      if (floatRoot.hidden || floatCollapsed) return;
      const raw = storageGet(STORAGE_FLOAT_POS, '');
      if (!raw) return;
      try {
        const saved = JSON.parse(raw);
        if (!Number.isFinite(Number(saved.left)) || !Number.isFinite(Number(saved.top))) return;
        const pos = clampFloat(Number(saved.left), Number(saved.top));
        floatRoot.style.right = 'auto';
        floatRoot.style.bottom = 'auto';
        floatRoot.style.left = `${pos.left}px`;
        floatRoot.style.top = `${pos.top}px`;
      } catch (_) { /* ignore invalid position */ }
    }

    let dragging = false;
    let dragPointerId = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    listen(floatEls.drag, 'pointerdown', (event) => {
      if (floatRoot.hidden) return;
      dragging = true;
      dragPointerId = event.pointerId;
      const rect = floatRoot.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      floatRoot.style.right = 'auto';
      floatRoot.style.bottom = 'auto';
      floatRoot.style.left = `${rect.left}px`;
      floatRoot.style.top = `${rect.top}px`;
      try { floatEls.drag.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
      event.preventDefault();
    });
    listen(window, 'pointermove', (event) => {
      if (!dragging || event.pointerId !== dragPointerId) return;
      const pos = clampFloat(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
      floatRoot.style.left = `${pos.left}px`;
      floatRoot.style.top = `${pos.top}px`;
      event.preventDefault();
    }, { passive: false });
    function endDrag(event) {
      if (!dragging || (event && event.pointerId !== dragPointerId)) return;
      dragging = false;
      dragPointerId = null;
      const rect = floatRoot.getBoundingClientRect();
      const pos = clampFloat(rect.left, rect.top);
      floatRoot.style.left = `${pos.left}px`;
      floatRoot.style.top = `${pos.top}px`;
      persistFloatPosition(pos.left, pos.top);
    }
    listen(window, 'pointerup', endDrag);
    listen(window, 'pointercancel', endDrag);
    listen(window, 'resize', () => {
      if (floatCollapsed && !isPhoneViewport()) setFloatCollapsed(false);
      else if (!floatRoot.hidden && floatRoot.style.left) restoreOrClampFloatPosition();
      emit();
    });
    if (window.visualViewport) listen(window.visualViewport, 'resize', () => {
      if (floatCollapsed && !isPhoneViewport()) setFloatCollapsed(false);
      else if (!floatRoot.hidden) restoreOrClampFloatPosition();
    });

    function visualizerLevel(values, index, count, fallback, playing) {
      if (!playing) return 0.08;
      if (!fallback && values && values.length) {
        const maxBin = Math.min(values.length - 1, 72);
        const idx = Math.min(maxBin, Math.floor((index / Math.max(1, count - 1)) * maxBin));
        return Math.max(.035, Math.pow(values[idx] / 255, .78));
      }
      const wave = Math.sin((visualizerFrame * .09) + (index * .72)) * .5 + .5;
      const wave2 = Math.sin((visualizerFrame * .047) + (index * 1.37)) * .5 + .5;
      return .16 + ((wave * .56 + wave2 * .44) * .62);
    }

    function visualizerGradient(ctx, height) {
      const gradient = ctx.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, 'rgba(121,87,255,.88)');
      gradient.addColorStop(.55, 'rgba(177,112,255,.92)');
      gradient.addColorStop(1, 'rgba(90,221,255,.9)');
      return gradient;
    }

    function drawSpectrum(ctx, width, height, dpr, cssWidth, values, fallback, playing) {
      const bars = Math.max(16, Math.min(34, Math.floor(cssWidth / 11)));
      const gap = Math.max(2 * dpr, width * 0.004);
      const barWidth = Math.max(2 * dpr, (width - gap * (bars - 1)) / bars);
      const topPad = 9 * dpr;
      const usable = Math.max(4 * dpr, height - topPad - 4 * dpr);
      ctx.fillStyle = visualizerGradient(ctx, height);
      for (let i = 0; i < bars; i += 1) {
        const level = visualizerLevel(values, i, bars, fallback, playing);
        const barHeight = Math.max(2 * dpr, usable * level);
        const x = i * (barWidth + gap);
        const y = height - barHeight;
        const radius = Math.min(barWidth / 2, 3 * dpr);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, radius);
        else ctx.rect(x, y, barWidth, barHeight);
        ctx.fill();
      }
    }

    function drawMirror(ctx, width, height, dpr, cssWidth, values, fallback, playing) {
      const bars = Math.max(36, Math.min(120, Math.floor(cssWidth / 7)));
      const gap = 2 * dpr;
      const barWidth = Math.max(2 * dpr, (width - gap * (bars - 1)) / bars);
      const center = height / 2;
      const usableHalf = Math.max(3 * dpr, center - 6 * dpr);
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#38bdf8');
      gradient.addColorStop(.5, '#bae6fd');
      gradient.addColorStop(1, '#38bdf8');
      ctx.fillStyle = gradient;
      for (let i = 0; i < bars; i += 1) {
        const level = visualizerLevel(values, i, bars, fallback, playing);
        const halfHeight = Math.max(1.5 * dpr, usableHalf * level);
        const x = i * (barWidth + gap);
        const y = center - halfHeight;
        const fullHeight = halfHeight * 2;
        const radius = Math.min(barWidth / 2, 3 * dpr);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, barWidth, fullHeight, radius);
        else ctx.rect(x, y, barWidth, fullHeight);
        ctx.fill();
      }
      ctx.globalAlpha = .22;
      ctx.fillRect(0, center - .5 * dpr, width, dpr);
      ctx.globalAlpha = 1;
    }

    function drawLine(ctx, width, height, dpr, cssWidth, values, fallback, playing) {
      const points = Math.max(32, Math.min(84, Math.floor(cssWidth / 5)));
      const topPad = 8 * dpr;
      const usable = Math.max(4 * dpr, height - topPad - 8 * dpr);
      const baseline = height - 4 * dpr;
      ctx.beginPath();
      for (let i = 0; i < points; i += 1) {
        const level = visualizerLevel(values, i, points, fallback, playing);
        const x = (i / Math.max(1, points - 1)) * width;
        const y = baseline - (usable * level);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(118,218,255,.96)';
      ctx.lineWidth = Math.max(1.5 * dpr, 2);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(121,87,255,.55)';
      ctx.shadowBlur = 6 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    function drawWave(ctx, width, height, dpr, timeValues, fallback, playing) {
      const center = height / 2;
      const amplitude = Math.max(3 * dpr, height * .38);
      const points = Math.max(48, Math.min(160, Math.floor(width / (3 * dpr))));
      ctx.beginPath();
      for (let i = 0; i < points; i += 1) {
        const x = (i / Math.max(1, points - 1)) * width;
        let normalized = 0;
        if (playing && !fallback && timeValues && timeValues.length) {
          const idx = Math.min(timeValues.length - 1, Math.floor((i / Math.max(1, points - 1)) * (timeValues.length - 1)));
          normalized = (timeValues[idx] - 128) / 128;
        } else if (playing) {
          const phase = visualizerFrame * .075 + i * .28;
          normalized = Math.sin(phase) * .56 + Math.sin(phase * .47 + .8) * .24;
        }
        const y = center - (normalized * amplitude);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = playing ? 'rgba(177,112,255,.96)' : 'rgba(177,112,255,.32)';
      ctx.lineWidth = Math.max(1.5 * dpr, 2);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(90,221,255,.45)';
      ctx.shadowBlur = playing ? 5 * dpr : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    function drawRibbon(ctx, width, height, dpr, values, fallback, playing) {
      const phase = visualizerFrame * .014;
      const colors = ['#82563c', '#b97b4b', '#e2a857', '#ffe0a0', '#ecc683', '#bcb995'];
      ctx.save();
      ctx.lineWidth = 1.2 * dpr;
      ctx.lineJoin = 'round';
      const points = 100;
      colors.forEach((color, layer) => {
        ctx.beginPath();
        for (let i = 0; i <= points; i++) {
          const t = i / points;
          const envelope = Math.sin(Math.PI * t) ** 1.2;
          const level = visualizerLevel(values, Math.min(i, points - i), points / 2, fallback, playing);
          const swing = Math.sin(t * Math.PI * 3 + phase + layer * .19);
          const ripple = Math.sin(t * Math.PI * 7 - phase * .6 + layer * .3) * .18;
          const y = height * .5 + (swing + ripple) * envelope * height * (.10 + level * .27) + (layer - 2.5) * height * .027;
          if (!i) ctx.moveTo(t * width, y); else ctx.lineTo(t * width, y);
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = playing ? .85 : .35;
        ctx.shadowColor = color;
        ctx.shadowBlur = playing ? 5 * dpr : 0;
        ctx.stroke();
      });
      ctx.restore();
    }

    function drawConstellation(ctx, width, height, dpr, values, fallback, playing) {
      const count = width / dpr < 500 ? 32 : 56;
      const phase = visualizerFrame * .006;
      const nodes = [];
      ctx.save();
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const level = visualizerLevel(values, i, count, fallback, playing);
        const orbit = i * 2.39996 + phase;
        nodes.push({
          x: width * (.07 + t * .86) + Math.sin(orbit * .7) * width * .025,
          y: height * .5 + Math.sin(orbit) * height * (.12 + level * .25) * Math.sin(Math.PI * t),
          radius: (1 + level * 1.9) * dpr,
          level,
        });
      }
      nodes.forEach((node, i) => {
        // Two neighboring links per particle keep the mesh bounded on mobile.
        for (let gap = 1; gap <= 2 && i + gap < count; gap++) {
          const next = nodes[i + gap];
          ctx.strokeStyle = `rgba(110,194,167,${playing ? .10 + node.level * .18 : .09})`;
          ctx.lineWidth = .7 * dpr;
          ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(next.x, next.y); ctx.stroke();
        }
        ctx.fillStyle = i % 4 === 0 ? '#f2cf8e' : '#92d5bf';
        ctx.globalAlpha = playing ? .55 + node.level * .45 : .35;
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = playing ? 6 * dpr : 0;
        ctx.beginPath(); ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      });
      ctx.restore();
    }

    function tubeLayout(width, height) {
      const scale = Math.min(width / 2004, height / 396);
      return { scale, x: (width - 2004 * scale) / 2, y: (height - 396 * scale) / 2 };
    }

    let analogVuLeft = .03;
    let analogVuRight = .03;

    function vuLevel(samples) {
      if (!samples || !samples.length) return 0;
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / samples.length);
      return rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 40) / 40)) : 0;
    }

    function drawTubeSpectrum(ctx, width, height, dpr, cssWidth, values, fallback, playing) {
      if (!tubeImage.complete || !tubeImage.naturalWidth) return;
      ctx.save();
      // Preserve the image aspect ratio inside the same viewport as every other mode.
      const layout = tubeLayout(width, height);
      ctx.translate(layout.x, layout.y);
      ctx.scale(layout.scale, layout.scale);
      ctx.translate(-22, -34);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(22, 34, 2004, 396, 38);
      else ctx.rect(22, 34, 2004, 396);
      ctx.clip();
      ctx.drawImage(tubeImage, 0, 0);
      [788, 1258].forEach((pivotX, i) => {
        const level = i === 0 ? analogVuLeft : analogVuRight;
        const angle = (-135 + level * 90) * Math.PI / 180;
        ctx.save();
        ctx.beginPath();
        ctx.rect(pivotX - 163, 154, 326, 168);
        ctx.clip();
        ctx.strokeStyle = '#241809';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pivotX, 335);
        ctx.lineTo(pivotX + Math.cos(angle) * 158, 335 + Math.sin(angle) * 158);
        ctx.stroke();
        ctx.restore();
      });
      if (!playing) {
        // Cover the illuminated parts baked into the supplied image when playback stops.
        [[227, 239, 27], [1024, 191, 23]].forEach(([x, y, radius]) => {
          const shade = ctx.createRadialGradient(x, y, radius * .38, x, y, radius);
          shade.addColorStop(0, 'rgba(12,9,7,.97)');
          shade.addColorStop(.70, 'rgba(12,9,7,.94)');
          shade.addColorStop(1, 'rgba(12,9,7,0)');
          ctx.fillStyle = shade;
          ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
        });
        ctx.fillStyle = '#350805';
        ctx.fillRect(127, 199, 51, 76);
        ctx.strokeStyle = '#8c3226';
        ctx.lineWidth = 3;
        ctx.strokeRect(128, 200, 49, 74);
        ctx.fillStyle = '#ad8277';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('I', 153, 226);
        ctx.fillStyle = '#f2d7b8';
        ctx.fillText('O', 153, 263);
      }
      ctx.restore();
    }

    function drawCanvas(canvas, values, timeValues, fallback, playing, mode) {
      if (!canvas || !canvas.isConnected || !canvas.getClientRects().length) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(cssWidth * dpr);
      const height = Math.round(cssHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const visualMode = normalizeVisualizerMode(mode);
      if (visualMode === 'mirror') drawMirror(ctx, width, height, dpr, cssWidth, values, fallback, playing);
      else if (visualMode === 'line') drawLine(ctx, width, height, dpr, cssWidth, values, fallback, playing);
      else if (visualMode === 'wave') drawWave(ctx, width, height, dpr, timeValues, fallback, playing);
      else if (visualMode === 'tube') {
        drawTubeSpectrum(ctx, width, height, dpr, cssWidth, values, fallback, playing);
        const layout = tubeLayout(width, height);
        const power = canvas.parentElement.querySelector('[data-jazzradio-power]');
        power.style.left = `${(layout.x + 131 * layout.scale) / width * 100}%`;
        power.style.top = `${(layout.y + 203 * layout.scale) / height * 100}%`;
        power.style.width = `${96 * layout.scale / width * 100}%`;
        power.style.height = `${124 * layout.scale / height * 100}%`;
      }
      else if (visualMode === 'ribbon') drawRibbon(ctx, width, height, dpr, values, fallback, playing);
      else if (visualMode === 'constellation') drawConstellation(ctx, width, height, dpr, values, fallback, playing);
      else drawSpectrum(ctx, width, height, dpr, cssWidth, values, fallback, playing);
    }

    function hasUsableFrequencyData(values) {
      if (!values || !values.length) return false;
      for (let i = 0; i < values.length; i += 1) {
        if (values[i] > 2) return true;
      }
      return false;
    }

    function hasUsableTimeData(values) {
      if (!values || !values.length) return false;
      for (let i = 0; i < values.length; i += 1) {
        if (Math.abs(values[i] - 128) > 2) return true;
      }
      return false;
    }

    function scheduleVisualizers() {
      if (!disposed && !frameId && !document.hidden) frameId = window.requestAnimationFrame(drawVisualizers);
    }

    function drawVisualizers() {
      frameId = 0;
      if (disposed || document.hidden) return;
      const canvases = Array.from(document.querySelectorAll('[data-jazzradio-visualizer]')).filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!canvases.length) return;
      visualizerFrame += 1;
      const playing = currentPlaying();
      let values = null;
      let waveValues = null;
      if (analyser && playing && audioContext.state === 'running') {
        try {
          analyser.getByteFrequencyData(frequencyData);
          analyser.getByteTimeDomainData(timeData);
          channelAnalysers.forEach((node, i) => node.getByteTimeDomainData(channelData[i]));
          values = frequencyData;
          waveValues = timeData;
        } catch (error) {
          if (analysisStatus !== 'unavailable') console.warn('[jazzradio] Audio analysis failed:', error);
        }
      }
      const hasData = hasUsableFrequencyData(values) || hasUsableTimeData(waveValues);
      if (playing && !hasData) { if (!silentSince) silentSince = performance.now(); }
      else silentSince = 0;
      const status = !playing ? 'idle' : hasData ? 'live' : silentSince && performance.now() - silentSince > 3000 ? 'unavailable' : 'waiting';
      if (status !== analysisStatus) {
        analysisStatus = status;
        if (status === 'unavailable') console.warn('[jazzradio] No Web Audio samples from this stream', {contextState: audioContext && audioContext.state, readyState: audio.readyState, src: audio.currentSrc});
        emit();
      }
      const left = playing && hasData ? vuLevel(channelData[0]) : 0;
      const right = playing && hasData ? vuLevel(channelData[1]) : 0;
      analogVuLeft = playing ? analogVuLeft + (left - analogVuLeft) * (left > analogVuLeft ? .35 : .12) : 0;
      analogVuRight = playing ? analogVuRight + (right - analogVuRight) * (right > analogVuRight ? .35 : .12) : 0;
      canvases.forEach(canvas => drawCanvas(canvas, values, waveValues, !hasData, playing, state.visualizerMode));
      if (playing) scheduleVisualizers();
    }

    function attachView(viewRoot, render) {
      const binding = { root: viewRoot, render };
      viewBindings.add(binding);
      render(snapshot());
      syncFloatVisibility();
      return function detach() { viewBindings.delete(binding); syncFloatVisibility(); };
    }

    const observer = new MutationObserver(() => syncFloatVisibility());
    observer.observe(document.body, { childList: true, subtree: true });
    const metadataTimer = window.setInterval(() => {
      if (currentPlaying()) refreshNowPlaying();
    }, METADATA_POLL_MS);
    const visibilityTimer = window.setInterval(syncFloatVisibility, 750);
    listen(document, 'visibilitychange', () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      } else {
        if (currentPlaying()) { resumeAudioContext(); refreshNowPlaying(); }
        scheduleVisualizers();
      }
    });

    state.volume = Number(storageGet(STORAGE_VOLUME, '70'));
    if (!Number.isFinite(state.volume)) state.volume = 70;
    state.volume = Math.max(0, Math.min(100, Math.round(state.volume)));
    if (!isIOSDevice()) audio.volume = state.volume / 100;
    refreshNoiseControls();
    renderFloat();

    function destroy() {
      stop();
      disposed = true;
      window.clearTimeout(noiseControlsTimer);
      window.cancelAnimationFrame(frameId);
      window.clearInterval(metadataTimer);
      window.clearInterval(visibilityTimer);
      observer.disconnect();
      listeners.forEach(remove => remove());
      viewBindings.clear();
      tubeImage.onload = null;
      [mediaSource, splitter, merger, analyser, ...channelAnalysers].forEach(node => { if (node) node.disconnect(); });
      if (audioContext) audioContext.close().catch(() => {});
      audio.remove();
      floatRoot.remove();
      style.remove();
    }

    return {
      version: ENGINE_VERSION,
      destroy,
      getDiagnostics: () => ({
        noiseActive: !!noiseSource,
        noiseGain: noiseGain ? noiseGain.gain.value : 0,
        analysisStatus,
        contextState: audioContext ? audioContext.state : 'uninitialized',
        readyState: audio.readyState,
        stream: audio.currentSrc,
        vuLeft: analogVuLeft,
        vuRight: analogVuRight,
      }),
      audio,
      attachView,
      setStations,
      getState: snapshot,
      selectStation,
      play,
      pause,
      toggle,
      stop,
      setVolume,
      toggleNoise,
      setNoiseLevel,
      setVisualizerMode,
      cycleVisualizerMode,
      refreshNowPlaying,
      syncFloatVisibility,
    };
  }

  let engine = window[GLOBAL_KEY];
  if (!engine || engine.version !== ENGINE_VERSION || !engine.audio || !engine.audio.isConnected) {
    if (engine && typeof engine.destroy !== 'function') {
      engine.stop();
      const message = root.querySelector('#jazzradio-message');
      message.textContent = '플레이어 업데이트를 적용하려면 페이지를 새로고침해 주세요.';
      message.hidden = false;
      return;
    }
    if (engine) engine.destroy();
    engine = createEngine();
    window[GLOBAL_KEY] = engine;
  }

  const stationsEl = root.querySelector('#jazzradio-stations');
  const messageEl = root.querySelector('#jazzradio-message');
  const playButton = root.querySelector('#jazzradio-play');
  const volumeWrap = root.querySelector('#jazzradio-volume-wrap');
  const volume = root.querySelector('#jazzradio-volume');
  const volumeValue = root.querySelector('#jazzradio-volume-value');
  const volumeNote = root.querySelector('#jazzradio-volume-note');
  const nowArtist = root.querySelector('#jazzradio-now-artist');
  const nowTitle = root.querySelector('#jazzradio-now-title');
  const nowQuality = root.querySelector('#jazzradio-now-quality');
  const controlDisc = root.querySelector('#jazzradio-control-disc');
  const visualizerModeButton = root.querySelector('#jazzradio-visualizer-mode');
  const mainVisualizer = root.querySelector('.jazzradio-visualizer');
  const visualizerModeLabelEl = root.querySelector('[data-jazzradio-visualizer-mode-label]');
  const coverImg = root.querySelector('#jazzradio-cover-img');
  const coverPlaceholder = root.querySelector('#jazzradio-cover-placeholder');

  function applyMainArtwork(nowPlaying) {
    const src = String((nowPlaying && nowPlaying.album_art) || '');
    if (!src || coverImg.dataset.failedUrl === src) {
      coverImg.hidden = true;
      coverPlaceholder.hidden = false;
      if (!src) coverImg.removeAttribute('src');
      return;
    }
    if (coverImg.getAttribute('src') !== src) {
      coverImg.hidden = true;
      coverPlaceholder.hidden = false;
      coverImg.dataset.failedUrl = '';
      coverImg.alt = nowPlaying && nowPlaying.artist ? `${nowPlaying.artist} 앨범 커버` : '앨범 커버';
      coverImg.src = src;
      return;
    }
    if (coverImg.complete && coverImg.naturalWidth > 0) {
      coverImg.hidden = false;
      coverPlaceholder.hidden = true;
    }
  }

  coverImg.addEventListener('load', () => { coverImg.hidden = false; coverPlaceholder.hidden = true; });
  coverImg.addEventListener('error', () => {
    coverImg.dataset.failedUrl = coverImg.getAttribute('src') || '';
    coverImg.hidden = true;
    coverPlaceholder.hidden = false;
  });

  function renderStations(snap) {
    stationsEl.innerHTML = snap.stations.map((station) => `
      <button type="button" class="jazzradio-card${snap.selectedStation && snap.selectedStation.id === station.id ? ' active' : ''}" data-station-id="${escapeHtml(station.id)}">
        <span class="jazzradio-card-top"><span class="jazzradio-card-icon"><i class="${escapeHtml(station.icon || 'fa-solid fa-music')}"></i></span><span class="jazzradio-badge">LIVE</span></span>
        <strong>${escapeHtml(station.name)}</strong>
        <span class="jazzradio-subtitle">${escapeHtml(station.subtitle)}</span>
        <span class="jazzradio-description">${escapeHtml(station.description)}</span>
        <span class="jazzradio-quality"><i class="fa-solid fa-wave-square"></i> ${escapeHtml(station.quality)}</span>
      </button>
    `).join('');
    stationsEl.querySelectorAll('.jazzradio-card').forEach((card) => {
      card.addEventListener('click', () => engine.selectStation(card.dataset.stationId, true));
    });
  }

  let renderedStationSignature = '';
  function renderView(snap) {
    const station = snap.selectedStation;
    const np = snap.nowPlaying;
    const signature = snap.stations.map((s) => s.id).join('|') + '::' + (station ? station.id : '');
    if (signature !== renderedStationSignature) {
      renderedStationSignature = signature;
      renderStations(snap);
    } else {
      stationsEl.querySelectorAll('.jazzradio-card').forEach((card) => card.classList.toggle('active', !!station && card.dataset.stationId === station.id));
    }

    playButton.disabled = !station;
    playButton.innerHTML = snap.playing ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
    playButton.setAttribute('aria-label', snap.playing ? '일시정지' : '재생');
    controlDisc.classList.toggle('playing', snap.playing);
    controlDisc.setAttribute('aria-pressed', String(snap.noiseEnabled));
    controlDisc.title = snap.noiseEnabled ? 'LP 노이즈 끄기' : 'LP 노이즈 켜기';
    const noiseControls = root.querySelector('.jazzradio-noise');
    noiseControls.hidden = !snap.noiseEnabled || !snap.noiseControlsVisible;
    noiseControls.querySelector('input').value = String(snap.noiseLevel);
    noiseControls.querySelector('output').textContent = `${snap.noiseLevel}%`;
    const power = root.querySelector('[data-jazzradio-power]');
    power.hidden = snap.visualizerMode !== 'tube';
    power.disabled = !station;
    power.setAttribute('aria-pressed', String(snap.playing));
    power.setAttribute('aria-label', snap.playing ? '라디오 일시정지' : '라디오 재생');
    const analysisNote = root.querySelector('[data-jazzradio-analysis-note]');
    analysisNote.hidden = snap.analysisStatus !== 'unavailable';
    if (visualizerModeButton && visualizerModeLabelEl) {
      visualizerModeButton.dataset.mode = snap.visualizerMode;
      if (mainVisualizer) mainVisualizer.dataset.mode = snap.visualizerMode;
      visualizerModeLabelEl.textContent = visualizerModeLabel(snap.visualizerMode);
      visualizerModeButton.title = `비주얼라이저 모드 변경 · 현재 ${visualizerModeLabel(snap.visualizerMode)}`;
    }

    if (!station) {
      nowArtist.textContent = '방송국을 선택하세요';
      nowTitle.textContent = '재생 중인 곡 정보가 여기에 표시됩니다.';
      nowQuality.textContent = '카드를 눌러 재생할 수 있습니다.';
      applyMainArtwork(null);
    } else if (np && np.station_id === station.id && np.available === true) {
      nowArtist.textContent = np.artist || station.name;
      nowTitle.textContent = np.title || np.raw || '곡명 정보 없음';
      nowQuality.textContent = `${station.name} · ${station.quality}${np.stale ? ' · 이전 정보' : ''}${snap.waiting ? ' · 연결 중...' : ''}`;
      applyMainArtwork(np);
    } else {
      nowArtist.textContent = snap.waiting ? '곡 정보 불러오는 중…' : station.name;
      nowTitle.textContent = snap.waiting ? '방송국에서 현재 재생 정보를 확인하고 있습니다.' : '재생 중인 곡 정보가 없습니다.';
      nowQuality.textContent = `${station.name} · ${station.quality}${snap.waiting ? ' · 연결 중...' : ''}`;
      applyMainArtwork(null);
    }

    messageEl.textContent = snap.error || '';
    messageEl.hidden = !snap.error;

    if (isIOSDevice()) {
      volumeWrap.classList.add('is-ios');
      volume.hidden = true;
      volumeValue.hidden = true;
      volumeNote.hidden = false;
      volumeNote.textContent = iosVolumeText();
    } else {
      volumeWrap.classList.remove('is-ios');
      volume.hidden = false;
      volumeValue.hidden = false;
      volumeNote.hidden = true;
      volume.value = String(snap.volume);
      volumeValue.textContent = `${snap.volume}%`;
    }
  }

  if (root.__jazzradioDetach) root.__jazzradioDetach();
  root.__jazzradioDetach = engine.attachView(root, renderView);
  playButton.onclick = () => engine.toggle();
  controlDisc.onclick = () => engine.toggleNoise();
  root.querySelector('#jazzradio-noise-level').oninput = event => engine.setNoiseLevel(event.target.value);
  volume.oninput = () => engine.setVolume(volume.value);
  if (mainVisualizer) mainVisualizer.onclick = event => {
    if (event.target.closest('[data-jazzradio-power]')) engine.toggle();
    else engine.cycleVisualizerMode();
  };

  function loadStations() {
    const existing = engine.getState().stations;
    if (existing && existing.length) {
      renderView(engine.getState());
      return Promise.resolve();
    }
    return fetch(DATA_URL, { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!data || data.success !== true || !Array.isArray(data.stations) || !data.stations.length) throw new Error('No stations returned');
        engine.setStations(data.stations);
      })
      .catch((error) => {
        console.error('[jazzradio] station load failed:', error);
        messageEl.textContent = '라디오 방송국 목록을 불러오지 못했습니다. BookOasis를 새로고침해 주세요.';
        messageEl.hidden = false;
      });
  }

  loadStations();
})();
