// 재생 엔진을 공유하는 재즈 라디오 화면과 하단 도크를 관리한다.
(function () {
  'use strict';

  const root = document.getElementById('jazzradio-app');
  if (!root) return;
  if (root.__jazzradioDetach) root.__jazzradioDetach();

  const GLOBAL_KEY = '__BookOasisJazzRadioPlayer';
  const ENGINE_VERSION = '1.12.0';
  const STORAGE_STATION = 'jazzradio.station';
  const STORAGE_VOLUME = 'jazzradio.volume';
  const STORAGE_VISUALIZER_MODE = 'jazzradio.visualizer.mode';
  const STORAGE_COLOR_THEME = 'jazzradio.color.theme';
  const STORAGE_COLOR_TONE = 'jazzradio.color.tone';
  const STORAGE_DOCK_POSITION = 'jazzradio.visualizer.position';
  const VISUALIZER_MODES = ['spectrum', 'mirror', 'line', 'wave', 'tube', 'ribbon', 'constellation', 'particle'];
  const VISUALIZER_LABELS = {
    spectrum: 'LIVE SPECTRUM',
    mirror: 'MIRROR BARS',
    line: 'LINE SPECTRUM',
    wave: 'WAVEFORM',
    tube: 'VINTAGE AMP',
    ribbon: 'AMBER RIBBON',
    constellation: 'JAZZ CONSTELLATION',
    particle: 'PARTICLE DANCE',
  };
  const DATA_URL = '/api/media/dashboard/widgets/jazzradio/data?type=general';
  const DEFAULT_BACKGROUND = {url:'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?auto=format&fit=crop&w=2200&q=80',source_url:'https://unsplash.com/s/photos/jazz?utm_source=bookoasis_jazzradio&utm_medium=referral'};
  const METADATA_POLL_MS = 12000;
  const PCM_CONNECT_MS = 12000;

  function createSpectrum256() {
    const real = new Float64Array(256), imaginary = new Float64Array(256);
    const coefficients = Float64Array.from({ length: 256 }, (_, i) => .42 - .5 * Math.cos(2 * Math.PI * i / 256) + .08 * Math.cos(4 * Math.PI * i / 256));
    const previous = new Float64Array(128);
    return function spectrum(samples, output, smoothing = 0) {
      for (let i = 0; i < 256; i++) { real[i] = samples[i] * coefficients[i]; imaginary[i] = 0; }
      for (let i = 1, j = 0; i < 256; i++) {
        let bit = 128;
        while (j & bit) { j ^= bit; bit >>= 1; }
        j ^= bit;
        if (i < j) { const value = real[i]; real[i] = real[j]; real[j] = value; }
      }
      for (let length = 2; length <= 256; length *= 2) {
        const angle = -2 * Math.PI / length, stepReal = Math.cos(angle), stepImaginary = Math.sin(angle);
        for (let start = 0; start < 256; start += length) {
          let twiddleReal = 1, twiddleImaginary = 0;
          for (let j = 0; j < length / 2; j++) {
            const left = start + j, right = left + length / 2;
            const rotatedReal = twiddleReal * real[right] - twiddleImaginary * imaginary[right];
            const rotatedImaginary = twiddleReal * imaginary[right] + twiddleImaginary * real[right];
            real[right] = real[left] - rotatedReal; imaginary[right] = imaginary[left] - rotatedImaginary;
            real[left] += rotatedReal; imaginary[left] += rotatedImaginary;
            const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
            twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
            twiddleReal = nextReal;
          }
        }
      }
      for (let i = 0; i < 128; i++) {
        const magnitude = smoothing * previous[i] + (1 - smoothing) * Math.hypot(real[i], imaginary[i]) / 256;
        previous[i] = magnitude;
        output[i] = Math.max(0, Math.min(255, Math.floor(255 * (20 * Math.log10(magnitude) + 90) / 75)));
      }
      return output;
    };
  }

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

  function normalizeColorTheme(value) {
    const color = /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
    return color === '#fbbf24' ? '#d6bd78' : color;
  }

  function normalizeColorTone(value) {
    const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 100;
  }

  function normalizeDockPosition(value) {
    return value === 'below' ? 'below' : 'above';
  }

  function createColorPalette(color, light, strength = 100) {
    if (!color && strength === 100) return null;
    const desaturate = hex => {
      const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
      const gray = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      return rgb.map(value => Math.round(gray + (value - gray) * strength / 100));
    };
    const ribbon = ['#82563c', '#b97b4b', '#e2a857', '#ffe0a0', '#ecc683', '#bcb995'];
    if (!color) {
      const shade = hex => desaturate(hex).join(',');
      return {
        accent: shade(light ? '#246d90' : '#54b2dc'), icon: shade(light ? '#315e77' : '#b9dcee'),
        primary: `rgb(${shade('#38bdf8')})`, soft: `rgb(${shade('#bae6fd')})`,
        line: shade('#76daff'), lineGlow: shade('#7957ff'), wave: shade(light ? '#246d90' : '#54b2dc'),
        ribbon: createColorPalette('#38bdf8', false, strength).ribbon,
      };
    }
    const original = desaturate(color === '#d6bd78' && light ? '#846023' : color);
    const luminance = rgb => rgb.map(value => {
      value /= 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const background = luminance(light ? [248, 246, 240] : [17, 21, 34]);
    let base = original;
    for (let step = 0; step <= 20; step++) {
      base = original.map(value => Math.round(value + ((light ? 0 : 255) - value) * step / 20));
      const level = luminance(base);
      if ((Math.max(level, background) + .05) / (Math.min(level, background) + .05) >= 4.5) break;
    }
    const mix = amount => base.map(value => Math.round(amount < 0 ? value * (1 + amount) : value + (255 - value) * amount));
    const lightness = hex => {
      const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
      return (Math.min(...rgb) + Math.max(...rgb)) / 510;
    };
    // 기존 그라데이션과 리본 층의 명암 차이를 선택한 색상 계열에 옮긴다.
    const tone = (source, reference) => {
      const level = lightness(source), anchor = lightness(reference);
      return mix(level >= anchor ? (level - anchor) / (1 - anchor) : (level - anchor) / anchor);
    };
    const soft = tone('#bae6fd', '#38bdf8');
    let primary = base;
    // 밝은 선택색도 중앙 하이라이트와 구별되도록 끝색만 어둡게 한다.
    if (!light) {
      for (let step = 1; step <= 20 && (luminance(soft) + .05) / (luminance(primary) + .05) < 1.5; step++) primary = mix(-step / 20);
    }
    return {
      accent: base.join(','), icon: mix(light ? 0 : .28).join(','), wave: base.join(','),
      primary: `rgb(${primary.join(',')})`, soft: `rgb(${soft.join(',')})`,
      line: tone('#76daff', '#38bdf8').join(','), lineGlow: tone('#7957ff', '#38bdf8').join(','),
      ribbon: ribbon.map(value => `rgb(${tone(value, '#e2a857').join(',')})`),
    };
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

  function elapsedText(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }

  function safeLink(value, hosts) {
    try { const url = new URL(value); return url.protocol === 'https:' && (!hosts || hosts.includes(url.hostname)) ? url.href : ''; }
    catch (_) { return ''; }
  }

  function iosVolumeText() {
    return '기기 볼륨';
  }

  function renderVolumeControls(els, snap) {
    const noise = snap.noiseEnabled && snap.noiseControlsVisible;
    const available = noise || !isIOSDevice();
    const level = noise ? snap.noiseLevel : snap.volume;
    els.volumeWrap.classList.toggle('is-ios', !available);
    els.volume.parentElement.hidden = !available;
    els.volume.hidden = !available;
    els.volumeNote.hidden = available;
    els.volumeNote.textContent = available ? '' : iosVolumeText();
    els.volume.setAttribute('aria-label', noise ? 'LP 노이즈 강도' : '볼륨');
    els.volume.value = String(level);
    els.volume.style.setProperty('--jr-volume', `${level}%`);
    els.volumeValue.hidden = !available || !(noise || snap.volumeControlsVisible);
    els.volumeValue.textContent = noise
      ? (snap.noiseValueVisible ? `LP 노이즈 ${level}%` : 'LP 노이즈')
      : `${level}%`;
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
      #jazzradio-app,#jazzradio-float-player{--jr-ink:#f5f1e8;--jr-muted:#b7bec8;--jr-mute:#ff9b82;--jr-gold:#d6bd78;--jr-accent-rgb:84,178,220;--jr-icon-rgb:185,220,238;--jr-accent:rgb(var(--jr-accent-rgb));--jr-icon:rgb(var(--jr-icon-rgb));--jr-surface:rgba(14,18,34,.43);--jr-panel:rgba(17,21,34,.96);--jr-dock:rgba(17,20,28,.58);--jr-dock-solid:#171d28;--jr-line:rgba(225,233,242,.18);--jr-tooltip:#172232;--jr-page:#111621;--jr-wash-start:rgba(7,12,20,.72);--jr-wash-end:rgba(10,17,28,.24);--jr-wash-bottom:rgba(6,9,16,.82)}
      #jazzradio-app[data-jazzradio-theme=light],#jazzradio-float-player[data-jazzradio-theme=light]{--jr-ink:#17263a;--jr-muted:#43546a;--jr-mute:#a43e28;--jr-gold:#846023;--jr-accent-rgb:36,109,144;--jr-icon-rgb:49,94,119;--jr-surface:rgba(255,252,245,.86);--jr-panel:rgba(250,247,240,.98);--jr-dock:rgba(248,246,240,.94);--jr-dock-solid:#f3f0e8;--jr-line:rgba(28,48,66,.24);--jr-tooltip:#ebe4d6;--jr-page:#f3f0e8;--jr-wash-start:rgba(248,246,240,.92);--jr-wash-end:rgba(248,246,240,.65);--jr-wash-bottom:rgba(248,246,240,.94)}
      #jazzradio-app :where(div,span),#jazzradio-float-player :where(div,span){color:inherit}

      #jazzradio-float-player{position:fixed;inset:auto 0 0;width:100%;z-index:999998;color:var(--jr-ink);background:var(--jr-dock);border-top:1px solid var(--jr-line);box-shadow:0 -12px 50px #0004;backdrop-filter:blur(24px) saturate(1.2);-webkit-backdrop-filter:blur(24px) saturate(1.2);font-family:inherit;transition:transform .25s ease;box-sizing:border-box;padding-bottom:env(safe-area-inset-bottom,0px)}
      #jazzradio-float-player[hidden],#jazzradio-float-player [hidden]{display:none!important}
      #jazzradio-float-player *{box-sizing:border-box}#jazzradio-float-player button{cursor:pointer;color:inherit;font:inherit}#jazzradio-float-player button:focus-visible{outline:2px solid var(--jr-accent);outline-offset:3px}
      #jazzradio-float-player .jrfp-body{display:grid;grid-template-columns:fit-content(346px) 246px minmax(160px,1fr);align-items:center;gap:22px;max-width:1600px;margin:auto;padding:18px 48px 13px}
      #jazzradio-float-player .jrfp-bar{display:contents;gap:inherit}
      #jazzradio-float-player .jrfp-home{display:flex;align-items:center;gap:inherit;min-width:0;padding:0;border:0;background:none;text-align:left;position:relative}#jazzradio-float-player .jrfp-home .jrfp-cover{display:block;flex-shrink:0}#jazzradio-float-player .jrfp-home .jrfp-meta{display:block;min-width:0}#jazzradio-float-player .jrfp-home .jrfp-meta>span{display:block}#jazzradio-float-player .jrfp-home::after{content:'Jazz Radio 홈 이동';position:absolute;z-index:3;left:0;bottom:calc(100% + 28px + env(safe-area-inset-bottom,0px));padding:6px 9px;border-radius:6px;background:var(--jr-tooltip);color:var(--jr-icon);font-size:11px;white-space:nowrap;opacity:0;transform:translateY(4px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}#jazzradio-float-player .jrfp-home:hover::after,#jazzradio-float-player .jrfp-home:focus-visible::after{opacity:1;transform:translateY(0)}
      #jazzradio-float-player .jrfp-cover{height:64px;width:64px;overflow:hidden;border-radius:6px;background:#292d36}#jazzradio-float-player .jrfp-cover img{display:block;width:100%;height:100%;object-fit:cover}#jazzradio-float-player .jrfp-cover-placeholder{display:grid;place-items:center;height:100%;font-size:24px;color:var(--jr-accent)}
      #jazzradio-float-player .jrfp-meta{min-width:0}#jazzradio-float-player .jrfp-artist{font-size:12px;color:var(--jr-muted);margin-top:4px}#jazzradio-float-player .jrfp-title{font-size:15px;font-weight:600}#jazzradio-float-player .jrfp-artist,#jazzradio-float-player .jrfp-title,#jazzradio-float-player .jrfp-station{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#jazzradio-float-player .jrfp-station{font-size:11px;color:var(--jr-muted);margin-top:4px}
      #jazzradio-float-player .jrfp-transport{display:flex;align-items:center;gap:12px}#jazzradio-float-player .jrfp-disc,#jazzradio-float-player .jrfp-play{display:grid;place-items:center;width:43px;height:43px;flex-shrink:0;padding:0;border:1px solid rgba(var(--jr-accent-rgb),0.267);border-radius:50%;background:transparent;font-size:14px}#jazzradio-float-player .jrfp-play{background:transparent;color:var(--jr-accent);border:2px solid var(--jr-accent)}#jazzradio-float-player .jrfp-disc{font-size:19px}#jazzradio-float-player .jrfp-disc[aria-pressed=true]{box-shadow:0 0 0 2px var(--jr-accent)}#jazzradio-float-player .jrfp-disc.playing i{animation:jazzradio-global-spin 3s linear infinite}
      #jazzradio-float-player .jrfp-progress{position:absolute;top:-1px;left:0;right:0;height:3px;background:rgba(var(--jr-accent-rgb),.15);pointer-events:none;z-index:2}#jazzradio-float-player .jrfp-progress>span{display:block;height:100%;width:0;background:var(--jr-accent)}#jazzradio-float-player.jrfp-collapsed .jrfp-progress{visibility:hidden}
      #jazzradio-float-player .jrfp-viz-panel,#jazzradio-float-player .jrfp-viz-clip{display:contents}#jazzradio-float-player .jrfp-visualizer-toggle{display:none}
      #jazzradio-float-player .jrfp-viz{width:100%;max-width:700px;justify-self:start;height:var(--jrfp-cover-size);min-width:0;position:relative;cursor:pointer}#jazzradio-float-player .jrfp-viz canvas{display:block;width:100%;height:100%;pointer-events:none}#jazzradio-float-player [data-jazzradio-power]{position:absolute;left:7.05%;top:36%;width:4.7%;height:30%;min-width:18px;min-height:18px;transform:translate(-50%,-50%);border:0;background:transparent}
      #jazzradio-float-player .jrfp-volume{display:flex;gap:8px;align-items:center;font-size:11px;min-width:0}#jazzradio-float-player .jrfp-volume input{width:100%;min-width:30px;accent-color:var(--jr-accent)}#jazzradio-float-player .jrfp-volume-value{font-size:9px;opacity:.6}#jazzradio-float-player .jrfp-volume-note{font-size:9px;white-space:nowrap}
      #jazzradio-float-player .jrfp-actions{position:absolute;z-index:1;right:18px;top:7px;display:flex;gap:2px}#jazzradio-float-player .jrfp-actions button{display:grid;place-items:center;width:26px;height:26px;background:none;border:0;font-size:12px;color:rgba(var(--jr-icon-rgb),0.627)}#jazzradio-float-player .jrfp-actions button:hover{color:var(--jr-accent)}
      #jazzradio-float-player .jrfp-peek{display:none;position:absolute;right:22px;top:-32px;height:32px;padding:0 15px;border-radius:10px 10px 0 0;border:1px solid rgba(var(--jr-accent-rgb),0.2);border-bottom:0;background:var(--jr-dock-solid);color:var(--jr-accent);font-size:10px}#jazzradio-float-player.jrfp-collapsed{transform:translateY(100%)}#jazzradio-float-player.jrfp-collapsed .jrfp-peek{display:block}
      #jazzradio-float-player{--jrfp-cover-size:64px}
      #jazzradio-app .jazzradio-range,#jazzradio-float-player .jazzradio-range{position:relative;display:flex;align-items:center;flex:1;min-width:30px}
      #jazzradio-app .jazzradio-volume-wrap .jazzradio-range{max-width:100px}
      #jazzradio-float-player .jrfp-controls{display:grid;grid-template-columns:98px minmax(0,1fr);gap:12px;align-items:center}
      #jazzradio-float-player .jrfp-controls .jrfp-transport{grid-column:1}
      #jazzradio-float-player .jrfp-controls .jrfp-volume{grid-column:2}
      #jazzradio-app .jazzradio-mute,#jazzradio-float-player .jrfp-mute{display:grid;place-items:center;flex-shrink:0;width:24px;height:28px;padding:0;border:0;background:transparent;color:var(--jr-accent);font-size:13px;cursor:pointer}
      #jazzradio-app .jazzradio-mute[aria-pressed=true],#jazzradio-float-player .jrfp-mute[aria-pressed=true]{color:var(--jr-mute)}
      #jazzradio-app .jazzradio-volume-value,#jazzradio-float-player .jrfp-volume-value{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:3px 6px;border-radius:5px;opacity:1;background:var(--jr-tooltip);color:var(--jr-icon);font-size:10px;white-space:nowrap;pointer-events:none}
      #jazzradio-app .jazzradio-range input,#jazzradio-float-player .jazzradio-range input{appearance:none;-webkit-appearance:none;background:transparent;height:24px;padding:0;margin:0;cursor:pointer;outline-offset:2px}
      #jazzradio-app .jazzradio-range input::-webkit-slider-runnable-track,#jazzradio-float-player .jazzradio-range input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(to right,var(--jr-accent) var(--jr-volume,70%),rgba(var(--jr-icon-rgb),0.2) var(--jr-volume,70%))}
      #jazzradio-app .jazzradio-range input::-webkit-slider-thumb,#jazzradio-float-player .jazzradio-range input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border:2px solid var(--jr-icon);border-radius:50%;background:var(--jr-accent);box-shadow:0 0 0 2px rgba(var(--jr-accent-rgb),0.333)}
      #jazzradio-app .jazzradio-range input::-moz-range-track,#jazzradio-float-player .jazzradio-range input::-moz-range-track{height:3px;background:rgba(var(--jr-icon-rgb),0.2);border-radius:3px}
      #jazzradio-app .jazzradio-range input::-moz-range-progress,#jazzradio-float-player .jazzradio-range input::-moz-range-progress{height:3px;background:var(--jr-accent);border-radius:3px}
      #jazzradio-app .jazzradio-range input::-moz-range-thumb,#jazzradio-float-player .jazzradio-range input::-moz-range-thumb{width:9px;height:9px;border:2px solid var(--jr-icon);border-radius:50%;background:var(--jr-accent)}
      @keyframes jazzradio-global-spin{to{transform:rotate(360deg)}}
      @media(max-width:800px),(max-width:1200px) and (any-pointer:coarse){
        #jazzradio-float-player{--jrfp-cover-size:58px;padding-bottom:0;border-top:0}#jazzradio-float-player .jrfp-body{display:flex;flex-direction:column;align-items:stretch;gap:0;padding:0}#jazzradio-float-player .jrfp-bar{position:relative;display:grid;order:0;border-top:1px solid var(--jr-line);padding:max(17.5px,env(safe-area-inset-bottom,0px)) 84px max(17.5px,env(safe-area-inset-bottom,0px)) 20px;grid-template-columns:minmax(0,1fr) auto;gap:10px}#jazzradio-float-player .jrfp-cover{width:58px;height:58px}
        #jazzradio-float-player .jrfp-controls{display:flex;align-items:center;gap:10px}#jazzradio-float-player .jrfp-volume{width:100px;flex:none}
        #jazzradio-float-player .jrfp-visualizer-toggle{display:grid;place-items:center;flex-shrink:0;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--jr-icon);font-size:15px}#jazzradio-float-player .jrfp-visualizer-toggle[aria-pressed=false] i{opacity:.45}
        #jazzradio-float-player .jrfp-viz-panel{display:grid;order:-1;width:100%;grid-template-rows:0fr;opacity:0;pointer-events:none;transition:grid-template-rows .32s ease,opacity .24s ease}#jazzradio-float-player .jrfp-viz-panel.is-open{grid-template-rows:1fr;opacity:1;pointer-events:auto}#jazzradio-float-player .jrfp-viz-clip{display:block;min-height:0;overflow:hidden;border-radius:12px 12px 0 0;background:transparent}#jazzradio-float-player[data-viz-position=below] .jrfp-viz-panel{order:1}#jazzradio-float-player .jrfp-viz{max-width:none;height:var(--jrfp-bar-height,124px)}#jazzradio-float-player.jrfp-collapsed .jrfp-viz-panel{grid-template-rows:0fr;opacity:0;pointer-events:none}
      }
      @media(max-width:540px){
        #jazzradio-float-player{--jrfp-cover-size:56px}#jazzradio-float-player .jrfp-bar{padding:max(17px,env(safe-area-inset-bottom,0px)) 16px;grid-template-columns:minmax(0,1fr);gap:10px}#jazzradio-float-player .jrfp-home{grid-column:1;grid-row:1}#jazzradio-float-player .jrfp-cover{width:56px;height:56px}#jazzradio-float-player .jrfp-title{font-size:16px;line-height:20px}#jazzradio-float-player .jrfp-artist{font-size:12px;line-height:15px}#jazzradio-float-player .jrfp-station{font-size:11px;line-height:13px}
        #jazzradio-float-player .jrfp-controls{grid-column:1;grid-row:2;display:flex;align-items:center;gap:10px;position:relative}#jazzradio-float-player .jrfp-transport{gap:9px}#jazzradio-float-player .jrfp-volume{flex:1;max-width:150px;gap:6px}#jazzradio-float-player .jrfp-volume-value{bottom:100%;line-height:12px;padding:1px 6px}
        #jazzradio-float-player .jrfp-actions{right:14px;top:1px}
      }
      @media(hover:hover) and (pointer:fine){#jazzradio-float-player .jrfp-visualizer-toggle:hover{background:rgba(var(--jr-accent-rgb),0.11)}}
      @media(prefers-reduced-motion:reduce){#jazzradio-float-player,#jazzradio-float-player *{animation:none!important;transition:none!important}}
    `;
    let floatRoot = document.getElementById('jazzradio-float-player');
    if (!floatRoot) {
      floatRoot = document.createElement('div');
      floatRoot.id = 'jazzradio-float-player';
      floatRoot.hidden = true;
      floatRoot.innerHTML = `
        <div class="jrfp-body"><div class="jrfp-bar"><div class="jrfp-progress" data-jazzradio-track-progress="float" role="progressbar" aria-label="추정 곡 진행률" aria-valuemin="0" aria-valuemax="100"><span></span></div><div class="jrfp-actions"><button type="button" class="jrfp-collapse" aria-label="플레이어 아래로 접기" title="아래로 접기" aria-expanded="true"><i class="fa-solid fa-chevron-down"></i></button><button type="button" class="jazzradio-float-close" aria-label="라디오 종료" title="라디오 종료"><i class="fa-solid fa-xmark"></i></button></div><button type="button" class="jrfp-home" aria-label="Jazz Radio 홈 이동"><span class="jrfp-cover"><img class="jrfp-cover-img" alt="" referrerpolicy="no-referrer" hidden><span class="jrfp-cover-placeholder"><i class="fa-solid fa-record-vinyl"></i></span></span><span class="jrfp-meta"><span class="jrfp-title">Jazz Radio</span><span class="jrfp-artist">재생 대기 중</span><span class="jrfp-station"></span></span></button><div class="jrfp-controls"><div class="jrfp-transport"><button type="button" class="jrfp-disc" aria-label="LP 노이즈" aria-pressed="false"><i class="fa-solid fa-compact-disc"></i></button><button type="button" class="jrfp-play" aria-label="재생"><i class="fa-solid fa-play"></i></button></div><div class="jrfp-volume"><button type="button" class="jrfp-mute" aria-label="음소거" title="음소거" aria-pressed="false"><i class="fa-solid fa-volume-low" aria-hidden="true"></i></button><span class="jazzradio-range"><input class="jrfp-volume-range" type="range" min="0" max="100" value="70" aria-label="볼륨"><span class="jrfp-volume-value" hidden>70%</span></span><span class="jrfp-volume-note" hidden></span></div><button type="button" class="jrfp-visualizer-toggle" title="비주얼라이저 끄기" aria-label="비주얼라이저" aria-pressed="true" aria-expanded="true" aria-controls="jazzradio-float-viz-panel"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i></button></div></div><div class="jrfp-viz-panel is-open" id="jazzradio-float-viz-panel"><div class="jrfp-viz-clip"><div class="jrfp-viz" role="group" tabindex="0" title="비주얼라이저 모드 변경" aria-label="비주얼라이저 모드 변경"><canvas data-jazzradio-visualizer="float" aria-hidden="true"></canvas><button type="button" data-jazzradio-power aria-label="라디오 재생" aria-pressed="false" hidden></button></div></div></div></div>
        <button type="button" class="jrfp-peek" aria-label="플레이어 펼치기"><i class="fa-solid fa-chevron-up"></i> Jazz Radio</button>`;
      document.body.appendChild(floatRoot);
    }

    const state = {
      stations: [],
      selectedStation: null,
      nowPlaying: null,
      sessionStarted: false,
      waiting: false,
      error: '',
      volume: 70,
      muted: false,
      volumeControlsVisible: false,
      visualizerEnabled: true,
      noiseEnabled: storageGet('jazzradio.noise.enabled', 'false') === 'true',
      noiseControlsVisible: false,
      noiseValueVisible: false,
      noiseLevel: Math.max(0, Math.min(100, Number(storageGet('jazzradio.noise.level', '30')) || 0)),
      visualizerMode: normalizeVisualizerMode(storageGet(STORAGE_VISUALIZER_MODE, 'spectrum')),
      colorTheme: normalizeColorTheme(storageGet(STORAGE_COLOR_THEME, '')),
      colorTone: normalizeColorTone(storageGet(STORAGE_COLOR_TONE, '100')),
      dockVisualizerPosition: normalizeDockPosition(storageGet(STORAGE_DOCK_POSITION, 'above')),
    };

    const viewBindings = new Set();
    let lightTheme = false;
    let colorPalette = null;
    const defaultRibbonColors = createColorPalette('#38bdf8', false).ribbon;
    const themeProbe = document.createElement('span');
    themeProbe.hidden = true;
    themeProbe.style.backgroundColor = 'var(--app-bg-main,#111621)';
    floatRoot.appendChild(themeProbe);
    function syncTheme() {
      const [red, green, blue] = getComputedStyle(themeProbe).backgroundColor.match(/[\d.]+/g).map(Number);
      lightTheme = red * .299 + green * .587 + blue * .114 > 150;
      const theme = lightTheme ? 'light' : 'dark';
      colorPalette = createColorPalette(state.colorTheme, lightTheme, state.colorTone);
      floatRoot.dataset.jazzradioTheme = theme;
      applyColorTheme(floatRoot);
      viewBindings.forEach(binding => { binding.root.dataset.jazzradioTheme = theme; applyColorTheme(binding.root); });
      scheduleVisualizers();
    }

    function applyColorTheme(viewRoot) {
      for (const [property, value] of [['--jr-accent-rgb', colorPalette && colorPalette.accent], ['--jr-icon-rgb', colorPalette && colorPalette.icon]]) {
        if (value) viewRoot.style.setProperty(property, value);
        else viewRoot.style.removeProperty(property);
      }
      viewRoot.querySelectorAll('.jrfp-disc').forEach(button => { button.style.color = colorPalette ? 'var(--jr-icon)' : ''; });
    }

    let pollBusy = false;
    let audioContext = null;
    let previousIOSSessionType = null;
    let mediaSource = null;
    let noiseSource = null;
    let noiseControlsTimer = null;
    let noiseValueTimer = null;
    let volumeControlsTimer = null;
    let noiseGain = null;
    let removeNoiseContextListener = null;
    let analyser = null;
    let frequencyData = null;
    let timeData = null;
    let visualizerFrame = 0;
    let particleTime = 0;
    let particleLastTime = 0;
    const particles = Array.from({ length: 420 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random() * 2 - 1,
      phase: Math.random() * Math.PI * 2,
      phaseY: Math.random() * Math.PI * 2,
      vx: (Math.random() < .5 ? -1 : 1) * (.008 + Math.random() * .018),
      vy: (Math.random() < .5 ? -1 : 1) * (.025 + Math.random() * .045),
      drift: .2 + Math.random() * .4,
      size: Math.random(),
      energy: 0,
      pulse: 0,
      motion: 0,
    }));
    const particleSprites = ['255,255,255', '205,187,255', '180,241,217', '247,246,176', '189,224,255', '246,191,217', '217,234,177', '113,229,119'].map(color => {
      const sprite = document.createElement('canvas');
      sprite.width = sprite.height = 64;
      const context = sprite.getContext('2d');
      const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
      glow.addColorStop(0, `rgba(${color},1)`);
      glow.addColorStop(.55, `rgba(${color},.95)`);
      glow.addColorStop(.75, `rgba(${color},.5)`);
      glow.addColorStop(1, `rgba(${color},0)`);
      context.fillStyle = glow;
      context.fillRect(0, 0, 64, 64);
      return sprite;
    });
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
    let pcmJob = null;
    let pcmError = '';
    let decoderPromise = null;
    let lastPlaybackError = '';
    let serverVersion = '미확인';
    let lastDiagnosticAt = 0;
    const listeners = [];
    const tubeImage = new Image();
    tubeImage.onload = () => scheduleVisualizers();
    tubeImage.src = root.querySelector('[data-jazzradio-tube-image]').src;

    function listen(target, event, handler, options) {
      target.addEventListener(event, handler, options);
      listeners.push(() => target.removeEventListener(event, handler, options));
    }

    const floatEls = {
      bar: floatRoot.querySelector('.jrfp-bar'),
      play: floatRoot.querySelector('.jrfp-play'),
      disc: floatRoot.querySelector('.jrfp-disc'),
      artist: floatRoot.querySelector('.jrfp-artist'),
      title: floatRoot.querySelector('.jrfp-title'),
      station: floatRoot.querySelector('.jrfp-station'),
      cover: floatRoot.querySelector('.jrfp-cover-img'),
      coverPlaceholder: floatRoot.querySelector('.jrfp-cover-placeholder'),
      mute: floatRoot.querySelector('.jrfp-mute'),
      volume: floatRoot.querySelector('.jrfp-volume-range'),
      volumeValue: floatRoot.querySelector('.jrfp-volume-value'),
      volumeNote: floatRoot.querySelector('.jrfp-volume-note'),
      volumeWrap: floatRoot.querySelector('.jrfp-volume'),
      close: floatRoot.querySelector('.jazzradio-float-close'),
      collapse: floatRoot.querySelector('.jrfp-collapse'),
      peek: floatRoot.querySelector('.jrfp-peek'),
      viz: floatRoot.querySelector('.jrfp-viz'),
      vizPanel: floatRoot.querySelector('.jrfp-viz-panel'),
      vizToggle: floatRoot.querySelector('.jrfp-visualizer-toggle'),
    };

    const barSizeObserver = new ResizeObserver(entries => {
      if (disposed) return;
      const entry = entries[0], box = entry.borderBoxSize;
      const height = box && (box[0] || box).blockSize || entry.target.getBoundingClientRect().height;
      const value = `${height}px`;
      if (height > 0 && floatRoot.style.getPropertyValue('--jrfp-bar-height') !== value) {
        floatRoot.style.setProperty('--jrfp-bar-height', value);
        scheduleVisualizers();
      }
    });
    barSizeObserver.observe(floatEls.bar, {box: 'border-box'});

    function currentPlaying() {
      if (isIOSDevice()) return !!pcmJob && pcmJob.context.state === 'running' && pcmPlaybackTime(pcmJob) >= pcmJob.startedAt && pcmPlaybackTime(pcmJob) < pcmJob.nextAt && !state.error;
      return state.sessionStarted && !audio.paused && !audio.ended && audio.readyState >= 3 && !state.waiting && !state.error;
    }

    let trackObservation = null;
    let lastProgressPlaying = performance.now();
    function observeTrack(np) {
      if (!np || !np.available || np.stale) { trackObservation = null; return; }
      const now = performance.now();
      if (trackObservation && now - trackObservation.confirmedAt > METADATA_POLL_MS * 2 + 10000) trackObservation = null;
      const key = [np.station_id, np.artist, np.title || np.raw].join('|');
      if (!trackObservation || trackObservation.key !== key) {
        const previous = trackObservation;
        const detectedChange = previous && previous.station === np.station_id && now - previous.confirmedAt <= METADATA_POLL_MS * 2 + 10000;
        trackObservation = { key, station: np.station_id, startedAt: detectedChange ? (previous.confirmedAt + now) / 2 : null };
      }
      trackObservation.confirmedAt = now;
      trackObservation.durationMs = Number.isFinite(np.duration_ms) && np.duration_ms > 0 ? np.duration_ms : 0;
    }

    function trackProgress() {
      const durationMs = trackObservation ? trackObservation.durationMs : (state.nowPlaying && Number.isFinite(state.nowPlaying.duration_ms) ? Math.max(0, state.nowPlaying.duration_ms) : 0);
      const estimated = !!trackObservation && performance.now() - trackObservation.confirmedAt <= METADATA_POLL_MS * 2 + 10000 && trackObservation.startedAt !== null && durationMs > 0;
      return { estimated, durationMs, elapsedMs: estimated ? Math.min(durationMs, Math.max(0, performance.now() - trackObservation.startedAt)) : 0 };
    }

    function updateTrackProgress() {
      const progress = trackProgress();
      document.querySelectorAll('[data-jazzradio-track-progress]').forEach(bar => {
        bar.classList.toggle('is-estimated', progress.estimated);
        const width = progress.estimated ? `${progress.elapsedMs / progress.durationMs * 100}%` : bar.dataset.jazzradioTrackProgress === 'float' ? '0%' : '100%';
        if (bar.firstElementChild.style.width !== width) bar.firstElementChild.style.width = width;
        if (progress.estimated) bar.setAttribute('aria-valuenow', String(Math.round(progress.elapsedMs / progress.durationMs * 100)));
        else bar.removeAttribute('aria-valuenow');
        bar.setAttribute('aria-valuetext', progress.estimated ? `${elapsedText(progress.elapsedMs / 1000)} / ${elapsedText(progress.durationMs / 1000)} 추정` : '현재 곡 위치 미확인');
      });
      document.querySelectorAll('[data-jazzradio-track-time]').forEach(el => {
        el.hidden = !progress.estimated;
        const text = progress.estimated ? elapsedText(progress.elapsedMs / 1000) : '';
        if (el.textContent !== text) el.textContent = text;
      });
      document.querySelectorAll('[data-jazzradio-track-total]').forEach(el => {
        el.hidden = !progress.durationMs;
        const text = progress.durationMs ? `${elapsedText(progress.durationMs / 1000)} · ${progress.estimated ? '추정' : '곡 길이'}${progress.estimated && progress.elapsedMs === progress.durationMs ? ' · 다음 곡 확인 중' : ''}` : '';
        if (el.textContent !== text) el.textContent = text;
      });
      document.querySelectorAll('[data-jazzradio-listen-time]').forEach(el => { el.hidden = progress.estimated; });
    }

    let listenedMs = 0;
    let lastListenTick = performance.now();
    function updateListenTime() {
      const now = performance.now();
      if (currentPlaying()) listenedMs += Math.max(0, now - lastListenTick);
      lastListenTick = now;
      if (currentPlaying()) lastProgressPlaying = now;
      else if (now - lastProgressPlaying > 3000) trackObservation = null;
      if (trackObservation && now - trackObservation.confirmedAt > METADATA_POLL_MS * 2 + 10000) trackObservation = null;
      updateTrackProgress();
      document.querySelectorAll('[data-jazzradio-elapsed]').forEach(el => { const text = elapsedText(listenedMs / 1000); if (el.textContent !== text) el.textContent = text; });
    }

    function snapshot() {
      return {
        stations: state.stations.slice(),
        selectedStation: state.selectedStation,
        nowPlaying: state.nowPlaying,
        sessionStarted: state.sessionStarted,
        waiting: isIOSDevice() ? !!pcmJob && !currentPlaying() : state.waiting,
        error: state.error,
        playing: currentPlaying(),
        elapsedSeconds: Math.floor(listenedMs / 1000),
        trackProgress: trackProgress(),
        volume: state.volume,
        muted: state.muted,
        volumeControlsVisible: state.volumeControlsVisible,
        visualizerEnabled: state.visualizerEnabled,
        noiseEnabled: state.noiseEnabled,
        noiseControlsVisible: state.noiseControlsVisible,
        noiseValueVisible: state.noiseValueVisible,
        noiseLevel: state.noiseLevel,
        visualizerMode: state.visualizerMode,
        colorTheme: state.colorTheme,
        colorTone: state.colorTone,
        dockVisualizerPosition: state.dockVisualizerPosition,
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
      if (shouldShow) viewBindings.forEach(binding => {
        const dialog = binding.root.querySelector('dialog[open]');
        if (dialog) dialog.close();
      });
    }

    function renderFloat() {
      floatRoot.dataset.vizPosition = state.dockVisualizerPosition;
      const station = state.selectedStation;
      const np = state.nowPlaying;
      const playing = currentPlaying();
      const canPause = playing || (isIOSDevice() && !!pcmJob);
      floatEls.play.innerHTML = canPause ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
      floatEls.play.setAttribute('aria-label', canPause ? '일시정지' : '재생');
      floatEls.disc.classList.toggle('playing', playing);
      floatEls.disc.setAttribute('aria-pressed', String(state.noiseEnabled));
      floatEls.disc.title = state.noiseEnabled ? 'LP 노이즈 끄기' : 'LP 노이즈 켜기';
      floatEls.viz.dataset.mode = state.visualizerMode;
      floatEls.vizPanel.classList.toggle('is-open', state.visualizerEnabled);
      floatEls.vizPanel.inert = !state.visualizerEnabled || floatRoot.classList.contains('jrfp-collapsed');
      floatEls.vizToggle.setAttribute('aria-pressed', String(state.visualizerEnabled));
      floatEls.vizToggle.setAttribute('aria-expanded', String(state.visualizerEnabled));
      floatEls.vizToggle.title = state.visualizerEnabled ? '비주얼라이저 끄기' : '비주얼라이저 켜기';
      const power = floatRoot.querySelector('[data-jazzradio-power]');
      power.hidden = !state.visualizerEnabled || state.visualizerMode !== 'tube';
      floatEls.viz.querySelector('canvas').hidden = !state.visualizerEnabled;
      floatEls.viz.tabIndex = state.visualizerEnabled ? 0 : -1;
      floatEls.mute.setAttribute('aria-pressed', String(state.muted));
      floatEls.mute.setAttribute('aria-label', state.muted ? '음소거 해제' : '음소거');
      floatEls.mute.title = state.muted ? '음소거 해제' : '음소거';
      floatEls.mute.innerHTML = `<i class="fa-solid fa-volume-${state.muted ? 'xmark' : 'low'}" aria-hidden="true"></i>`;
      power.disabled = !station;
      power.setAttribute('aria-pressed', String(playing));
      power.setAttribute('aria-label', playing ? '라디오 일시정지' : '라디오 재생');
      floatEls.artist.textContent = np && np.available === true ? (np.artist || (station && station.name) || 'Jazz Radio') : ((station && station.name) || 'Jazz Radio');
      floatEls.title.textContent = np && np.available === true ? (np.title || np.raw || '곡명 정보 없음') : (state.waiting ? '곡 정보 불러오는 중…' : '재생 중인 곡 정보가 없습니다.');
      floatEls.station.textContent = np && np.available ? np.album_name || '' : '';
      floatRoot.querySelector('.jrfp-home').setAttribute('aria-label', [floatEls.title.textContent, floatEls.artist.textContent, floatEls.station.textContent, 'Jazz Radio 홈 이동'].filter(Boolean).join(' · '));
      applyArtwork(floatEls.cover, floatEls.coverPlaceholder, np && np.album_art, np && np.artist ? `${np.artist} 앨범 커버` : '앨범 커버');
      renderVolumeControls(floatEls, state);
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
      updateTrackProgress();
      scheduleVisualizers();
    }

    function stopNoise() {
      if (noiseSource) { noiseSource.stop(); noiseSource.disconnect(); noiseSource = null; }
      if (noiseGain) { noiseGain.disconnect(); noiseGain = null; }
    }

    function releaseIOSContext() {
      if (!isIOSDevice()) return;
      stopNoise();
      if (removeNoiseContextListener) { removeNoiseContextListener(); removeNoiseContextListener = null; }
      const context = audioContext;
      audioContext = null;
      if (context) context.close().catch(() => {});
      if (previousIOSSessionType !== null) {
        try {
          if (navigator.audioSession && navigator.audioSession.type === 'playback') navigator.audioSession.type = previousIOSSessionType;
        } catch (error) { console.warn('[jazzradio] Audio Session restore failed:', error); }
        previousIOSSessionType = null;
      }
    }

    function syncNoise() {
      const volume = isIOSDevice() ? 1 : state.volume / 100;
      if (disposed || state.muted || !state.noiseEnabled || !state.noiseLevel || !volume || !currentPlaying() || !audioContext || audioContext.state !== 'running') {
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

    function refreshNoiseControls(showValue = false) {
      window.clearTimeout(noiseValueTimer);
      state.noiseValueVisible = state.noiseEnabled && showValue;
      if (state.noiseValueVisible) noiseValueTimer = window.setTimeout(() => { state.noiseValueVisible = false; emit(); }, 2000);
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
      else stopNoise();
      storageSet('jazzradio.noise.enabled', state.noiseEnabled);
      refreshNoiseControls();
      emit();
    }

    function setNoiseLevel(raw) {
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      state.noiseLevel = Math.max(0, Math.min(100, Math.round(value)));
      storageSet('jazzradio.noise.level', state.noiseLevel);
      refreshNoiseControls(true);
      emit();
    }

    function setVolume(raw) {
      let value = Number(raw);
      if (!Number.isFinite(value)) value = 70;
      value = Math.max(0, Math.min(100, Math.round(value)));
      state.volume = value;
      window.clearTimeout(volumeControlsTimer);
      state.volumeControlsVisible = true;
      volumeControlsTimer = window.setTimeout(() => { state.volumeControlsVisible = false; emit(); }, 2000);
      if (!isIOSDevice()) {
        audio.volume = value / 100;
        storageSet(STORAGE_VOLUME, value);
      }
      emit();
    }

    function adjustVolume(raw) {
      if (state.noiseEnabled && state.noiseControlsVisible) setNoiseLevel(raw);
      else setVolume(raw);
    }

    function toggleMuted() {
      state.muted = !state.muted;
      audio.muted = state.muted;
      if (pcmJob && pcmJob.startedAt) {
        const now = pcmJob.context.currentTime;
        pcmJob.gain.gain.cancelScheduledValues(now);
        pcmJob.gain.gain.setTargetAtTime(state.muted ? 0 : 1, Math.max(now, pcmJob.startedAt), .015);
      }
      emit();
    }

    function toggleVisualizer() {
      state.visualizerEnabled = !state.visualizerEnabled;
      emit();
    }

    function setVisualizerMode(rawMode) {
      const mode = normalizeVisualizerMode(rawMode);
      if (state.visualizerMode === mode) return;
      state.visualizerMode = mode;
      storageSet(STORAGE_VISUALIZER_MODE, mode);
      emit();
    }

    function setColorTheme(value) {
      const color = normalizeColorTheme(value);
      if (color === state.colorTheme) return;
      state.colorTheme = color;
      storageSet(STORAGE_COLOR_THEME, color);
      syncTheme();
      emit();
    }

    function setColorTone(value) {
      const tone = normalizeColorTone(value);
      if (tone === state.colorTone) return;
      state.colorTone = tone;
      storageSet(STORAGE_COLOR_TONE, tone);
      syncTheme();
      emit();
    }

    function setDockVisualizerPosition(value) {
      const position = normalizeDockPosition(value);
      if (position === state.dockVisualizerPosition) return;
      state.dockVisualizerPosition = position;
      storageSet(STORAGE_DOCK_POSITION, position);
      emit();
    }

    function cycleVisualizerMode() {
      const current = VISUALIZER_MODES.indexOf(state.visualizerMode);
      const next = VISUALIZER_MODES[(current + 1) % VISUALIZER_MODES.length];
      setVisualizerMode(next);
      return next;
    }

    function setStations(stations, version) {
      if (!Array.isArray(stations) || !stations.length) return;
      if (version) serverVersion = String(version);
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

    function relayUrl(station) {
      if (!station || !station.relay_url) return null;
      try {
        const url = new URL(station.relay_url, window.location.href);
        return url.origin === window.location.origin && /^https?:$/.test(url.protocol) ? url.href : null;
      } catch (_) { return null; }
    }

    function loadPCMDecoder() {
      if (window['mpg123-decoder']) return Promise.resolve();
      if (!decoderPromise) decoderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = window.setTimeout(() => finish(new Error('디코더 연결 시간 초과')), PCM_CONNECT_MS);
        function finish(error) {
          window.clearTimeout(timeout);
          script.remove();
          if (error) { decoderPromise = null; reject(error); }
          else resolve();
        }
        script.src = `${DATA_URL}&decoder=1`;
        script.onload = () => finish(window['mpg123-decoder'] ? null : new Error('디코더 파일을 확인해 주세요.'));
        script.onerror = () => finish(new Error('디코더 파일을 불러오지 못했습니다.'));
        document.head.appendChild(script);
      });
      return decoderPromise;
    }

    function stopPCMPlayback() {
      const job = pcmJob;
      pcmJob = null;
      if (!job) return;
      window.clearTimeout(job.timeout);
      window.clearInterval(job.monitor);
      job.controller.abort();
      if (job.reader) job.reader.cancel().catch(() => {});
      job.frames.length = 0;
      job.tail = null;
      const end = job.context.currentTime + .02;
      job.gain.gain.cancelScheduledValues(job.context.currentTime);
      job.gain.gain.setValueAtTime(job.gain.gain.value, job.context.currentTime);
      job.gain.gain.linearRampToValueAtTime(0, end);
      job.nodes.forEach(source => source.stop(end));
      if (!job.nodes.size || job.context.state !== 'running') job.gain.disconnect();
    }

    function armPCMTimeout(job) {
      window.clearTimeout(job.timeout);
      job.timeout = window.setTimeout(() => {
        if (pcmJob !== job) return;
        pcmError = 'PCM 재생 데이터 12초 대기 초과';
        state.error = pcmError;
        state.waiting = false;
        stopPCMPlayback();
        emit();
      }, PCM_CONNECT_MS);
    }

    async function startPCMPlayback(station, resumed) {
      const context = audioContext;
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      const job = pcmJob = { context, gain, nodes: new Set(), controller: new AbortController(), frames: [], spectrum: createSpectrum256(), mono: new Float32Array(256), samples: 0, status: 'loading' };
      // 화면 프레임이 멈춘 동안에도 LP와 재생 상태를 실제 음악 출력에 맞춘다.
      job.monitor = window.setInterval(() => {
        if (pcmJob !== job) return;
        const playing = currentPlaying();
        const status = job.samples ? (playing ? 'playing' : 'buffering') : 'loading';
        syncNoise();
        if (job.status === status) return;
        job.status = status;
        state.waiting = !playing;
        emit();
        if (playing) refreshNowPlaying();
      }, 100);
      armPCMTimeout(job);
      try {
        await Promise.all([resumed, loadPCMDecoder()]);
        if (!relayUrl(station)) throw new Error('방송 중계 주소를 확인해 주세요.');
        if (pcmJob !== job) return;
        job.decoder = new window['mpg123-decoder'].MPEGDecoder();
        await job.decoder.ready;
        job.decoderReady = true;
        if (pcmJob !== job) return;
        const response = await fetch(relayUrl(station), { credentials: 'same-origin', cache: 'no-store', signal: job.controller.signal });
        if (pcmJob !== job) { if (response.body) await response.body.cancel(); return; }
        if (!response.ok) throw new Error(`방송 중계 HTTP ${response.status}`);
        if (!/^audio\//i.test(response.headers.get('Content-Type') || '') || !response.body) throw new Error('서버 응답이 오디오 스트림이 아닙니다.');
        job.reader = response.body.getReader();
        while (pcmJob === job) {
          const { value, done } = await job.reader.read();
          if (pcmJob !== job) return;
          if (done) throw new Error('방송 스트림이 종료되었습니다.');
          for (let offset = 0; offset < value.length && pcmJob === job; offset += 8192) {
            // 예약된 소리와 같은 샘플을 보관하며 수신 묶음 사이에도 연속 재생한다.
            while (pcmJob === job && job.nextAt - context.currentTime > 2) await new Promise(resolve => window.setTimeout(resolve, 10));
            if (pcmJob !== job) return;
            const pcm = job.decoder.decode(value.subarray(offset, offset + 8192));
            if (!pcm.samplesDecoded) continue;
            const channels = [0, 1].map(i => {
              const samples = new Float32Array(1024 + pcm.samplesDecoded);
              if (job.tail) samples.set(job.tail[i]);
              samples.set(pcm.channelData[Math.min(i, pcm.channelData.length - 1)], 1024);
              return samples;
            });
            const buffer = context.createBuffer(2, pcm.samplesDecoded, pcm.sampleRate);
            for (let i = 0; i < 2; i++) buffer.copyToChannel(pcm.channelData[Math.min(i, pcm.channelData.length - 1)], i);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            if (!job.nextAt || job.nextAt < context.currentTime) {
              job.startedAt = job.nextAt = context.currentTime + .75;
              gain.gain.cancelScheduledValues(context.currentTime);
              gain.gain.setValueAtTime(0, context.currentTime);
              gain.gain.setValueAtTime(0, job.startedAt);
              gain.gain.linearRampToValueAtTime(state.muted ? 0 : 1, job.startedAt + .015);
            }
            const at = job.nextAt;
            job.nodes.add(source);
            source.onended = () => {
              source.disconnect();
              job.nodes.delete(source);
              if (pcmJob !== job && !job.nodes.size) gain.disconnect();
            };
            source.start(at);
            job.frames.push({ at, channels, length: pcm.samplesDecoded, sampleRate: pcm.sampleRate });
            job.tail = channels.map(channel => channel.slice(-1024));
            job.nextAt = at + pcm.samplesDecoded / pcm.sampleRate;
            job.samples += pcm.samplesDecoded;
            while (job.frames.length > 1 && job.frames[1].at <= pcmPlaybackTime(job)) job.frames.shift();
            armPCMTimeout(job);
            scheduleVisualizers();
          }
        }
      } catch (error) {
        if (pcmJob === job) {
          pcmError = error.message || 'PCM 재생 오류';
          state.error = pcmError;
          state.waiting = false;
          console.warn('[jazzradio] PCM playback unavailable:', error);
        }
      } finally {
        if (job.decoderReady) job.decoder.free();
        if (pcmJob === job) { stopPCMPlayback(); emit(); }
      }
    }

    function pcmPlaybackTime(job) {
      const context = job.context;
      const stamp = context.getOutputTimestamp && context.getOutputTimestamp();
      if (stamp && stamp.performanceTime > 0) return Math.min(context.currentTime, stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000);
      return Math.max(0, context.currentTime - (context.outputLatency || context.baseLatency || 0));
    }

    function readPCMAnalysis(job, dt) {
      const now = pcmPlaybackTime(job);
      job.analysisTime = now;
      while (job.frames.length > 1 && job.frames[1].at <= now) job.frames.shift();
      const frame = job.frames[0];
      if (!frame || now < frame.at || now > frame.at + frame.length / frame.sampleRate + .15) return;
      const end = 1025 + Math.min(frame.length - 1, Math.floor((now - frame.at) * frame.sampleRate));
      const byte = value => Math.max(0, Math.min(255, Math.floor(128 * (1 + value))));
      for (let i = 0; i < 1024; i++) {
        channelData[0][i] = byte(frame.channels[0][end - 1024 + i]);
        channelData[1][i] = byte(frame.channels[1][end - 1024 + i]);
      }
      for (let i = 0; i < 256; i++) {
        job.mono[i] = (frame.channels[0][end - 256 + i] + frame.channels[1][end - 256 + i]) / 2;
        timeData[i] = byte(job.mono[i]);
      }
      job.spectrum(job.mono, frequencyData, Math.pow(.82, dt * 60));
    }

    function setSourceForStation(station) {
      if (!station) return;
      const expected = new URL(station.stream_url, window.location.href).href;
      if (audio.src === expected) return;
      audio.pause();
      audio.src = expected;
      audio.load();
      if (frequencyData) frequencyData.fill(0);
      if (timeData) timeData.fill(128);
      channelData.forEach(data => data.fill(128));
      silentSince = 0;
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
        observeTrack(state.nowPlaying);
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
      if (isIOSDevice()) {
        if (!frequencyData) {
          frequencyData = new Uint8Array(128);
          timeData = new Uint8Array(256).fill(128);
          channelData = [new Uint8Array(1024).fill(128), new Uint8Array(1024).fill(128)];
        }
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return false;
      }
      try {
        if (isIOSDevice() && navigator.audioSession) {
          try {
            // iOS 무음 스위치가 음악까지 차단하지 않도록 Context 생성 전에 지정한다.
            const previous = navigator.audioSession.type;
            navigator.audioSession.type = 'playback';
            if (previousIOSSessionType === null) previousIOSSessionType = previous;
          } catch (error) { console.warn('[jazzradio] Audio Session playback unavailable:', error); }
        }
        // AudioContext와 PC의 미디어 연결은 사용자 재생 제스처 안에서 준비한다.
        if (!audioContext) {
          const context = audioContext = new AudioContextClass();
          const onStateChange = () => {
            if (audioContext !== context) return;
            if (isIOSDevice() && pcmJob && pcmJob.samples && context.state !== 'running') pause();
            syncNoise();
            scheduleVisualizers();
          };
          context.addEventListener('statechange', onStateChange);
          const remove = () => context.removeEventListener('statechange', onStateChange);
          if (isIOSDevice()) removeNoiseContextListener = remove;
          else listeners.push(remove);
        }
        if (isIOSDevice()) return true;
        resumeAudioContext();
        if (!analyser) {
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
          if (mediaSource) {
            // Upmix mono streams before splitting so both speakers keep their audio.
            mediaSource.connect(analyser);
            analyser.connect(splitter);
            channelAnalysers.forEach((node, i) => {
              splitter.connect(node, i);
              node.connect(merger, 0, i);
            });
            merger.connect(audioContext.destination);
          }
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
      trackObservation = null;
      lastProgressPlaying = performance.now();
      const station = state.selectedStation;
      if (!station) return;
      lastListenTick = performance.now();
      const revision = ++playRevision;
      stopPCMPlayback();
      pcmError = '';
      lastPlaybackError = '';
      state.sessionStarted = true;
      silentSince = 0;
      state.error = '';
      state.waiting = true;
      storageSet(STORAGE_STATION, station.id);
      if (isIOSDevice()) {
        if (!prepareVisualizerFromGesture()) {
          state.waiting = false;
          state.error = '오디오 재생을 준비하지 못했습니다. 다시 재생해 주세요.';
          emit();
          return;
        }
        startPCMPlayback(station, audioContext.resume());
        emit();
        return;
      }
      setSourceForStation(station);
      state.waiting = true;
      prepareVisualizerFromGesture();
      try {
        const request = audio.play();
        emit();
        refreshNowPlaying();
        await request;
        if (disposed || revision !== playRevision) return;
        state.waiting = false;
        emit();
      } catch (error) {
        if (disposed || revision !== playRevision) return;
        lastPlaybackError = error.name || '재생 오류';
        state.waiting = false;
        state.error = '재생을 시작하지 못했습니다. 다시 한 번 재생 버튼을 눌러 주세요.';
        console.warn('[jazzradio] play failed:', error);
        emit();
      }
    }

    function pause() {
      updateListenTime();
      trackObservation = null;
      playRevision += 1;
      state.waiting = false;
      stopPCMPlayback();
      cancelMetadata();
      audio.pause();
      emit();
    }

    function toggle() {
      if (!state.selectedStation) return;
      if (isIOSDevice() ? !pcmJob : audio.paused) play();
      else pause();
    }

    function stop() {
      updateListenTime();
      trackObservation = null;
      listenedMs = 0;
      playRevision += 1;
      stopPCMPlayback();
      pcmError = '';
      lastPlaybackError = '';
      cancelMetadata();
      setFloatCollapsed(false);
      audio.pause();
      releaseIOSContext();
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
      if (changed) { trackObservation = null; listenedMs = 0; lastListenTick = performance.now(); stopPCMPlayback(); pcmError = ''; cancelMetadata(); state.nowPlaying = null; }
      state.error = '';
      if (autoplay) play();
      else emit();
    }

    if (!isIOSDevice()) {
      listen(audio, 'ended', () => { stopPCMPlayback(); emit(); });
      listen(audio, 'volumechange', () => { state.volume = Math.round(audio.volume * 100); state.muted = audio.muted; emit(); });
      listen(audio, 'play', () => { emit(); });
      listen(audio, 'pause', () => {
        // A source change can queue this event after the new connection has started.
        if (audio.paused) { trackObservation = null; stopPCMPlayback(); stopNoise(); }
        emit();
      });
      listen(audio, 'playing', () => { resumeAudioContext(); state.waiting = false; state.error = ''; emit(); refreshNowPlaying(); });
      listen(audio, 'waiting', () => { stopPCMPlayback(); if (state.sessionStarted) { state.waiting = true; emit(); } });
      listen(audio, 'error', () => {
        if (!state.sessionStarted) return;
        lastPlaybackError = `미디어 오류 ${audio.error ? audio.error.code : 0}`;
        stopPCMPlayback();
        state.waiting = false;
        state.error = '방송 스트림에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        emit();
      });
    }

    listen(floatEls.disc, 'click', toggleNoise);
    listen(floatEls.play, 'click', toggle);
    listen(floatEls.vizToggle, 'click', toggleVisualizer);
    listen(floatEls.close, 'click', stop);
    listen(floatEls.mute, 'click', toggleMuted);
    listen(floatEls.volume, 'input', () => adjustVolume(floatEls.volume.value));
    const floatViz = floatEls.viz;
    if (floatViz) {
      listen(floatViz, 'click', event => {
        if (!state.visualizerEnabled) return;
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

    let floatCollapsed = false;
    function setFloatCollapsed(collapsed) {
      floatCollapsed = Boolean(collapsed);
      floatRoot.classList.toggle('jrfp-collapsed', floatCollapsed);
      floatEls.collapse.setAttribute('aria-expanded', String(!floatCollapsed));
      floatEls.vizPanel.inert = floatCollapsed || !state.visualizerEnabled;
    }
    listen(floatEls.collapse, 'click', () => setFloatCollapsed(true));
    listen(floatEls.peek, 'click', () => setFloatCollapsed(false));
    listen(floatRoot.querySelector('.jrfp-home'), 'click', async () => {
      setFloatCollapsed(false);
      const menu = document.querySelector('.menu-item[data-plugin-id="jazzradio"],li[data-plugin-id="jazzradio"]');
      if (menu) menu.click();
      else {
        try { const view = await import('/static/js/plugin_custom_view.js'); await view.mountCategoryPluginUI('jazzradio'); }
        catch (error) { console.warn('[jazzradio] home navigation failed:', error); }
      }
    });
    listen(window, 'resize', () => { scheduleVisualizers(); });

    function visualizerLevel(values, index, count, fallback, playing) {
      if (!playing) return 0.08;
      if (!fallback) {
        if (!values || !values.length) return .035;
        const maxBin = Math.min(values.length - 1, 72);
        const idx = Math.min(maxBin, Math.floor((index / Math.max(1, count - 1)) * maxBin));
        return Math.max(.035, Math.pow(values[idx] / 255, .78));
      }
      const wave = Math.sin((visualizerFrame * .09) + (index * .72)) * .5 + .5;
      const wave2 = Math.sin((visualizerFrame * .047) + (index * 1.37)) * .5 + .5;
      return .16 + ((wave * .56 + wave2 * .44) * .62);
    }

    function visualizerGradient(ctx, height) {
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, colorPalette ? colorPalette.primary : '#38bdf8');
      gradient.addColorStop(.5, colorPalette ? colorPalette.soft : '#bae6fd');
      gradient.addColorStop(1, colorPalette ? colorPalette.primary : '#38bdf8');
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
      ctx.fillStyle = visualizerGradient(ctx, height);
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
      ctx.strokeStyle = colorPalette ? `rgba(${colorPalette.line},.96)` : 'rgba(118,218,255,.96)';
      ctx.lineWidth = Math.max(1.5 * dpr, 2);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = colorPalette ? `rgba(${colorPalette.lineGlow},.55)` : 'rgba(121,87,255,.55)';
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
        } else if (playing && fallback) {
          const phase = visualizerFrame * .075 + i * .28;
          normalized = Math.sin(phase) * .56 + Math.sin(phase * .47 + .8) * .24;
        }
        const y = center - (normalized * amplitude);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const color = colorPalette ? colorPalette.wave : lightTheme ? '36,109,144' : '84,178,220';
      ctx.strokeStyle = `rgba(${color},${playing ? .96 : .32})`;
      ctx.lineWidth = Math.max(1.5 * dpr, 2);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = `rgba(${color},.45)`;
      ctx.shadowBlur = playing ? 5 * dpr : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    function drawRibbon(ctx, width, height, dpr, values, fallback, playing) {
      const phase = visualizerFrame * .014;
      const colors = colorPalette ? colorPalette.ribbon : defaultRibbonColors;
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

    function updateParticles(dt, values, playing) {
      if (!playing) return;
      let bass = 0;
      if (values && values.length) {
        const end = Math.min(8, values.length);
        for (let i = 1; i < end; i++) bass += values[i] / 255;
        bass /= Math.max(1, end - 1);
      }
      particles.forEach((particle, i) => {
        // Stable frequency assignment keeps main and mini particles in sync.
        const bin = values && values.length ? Math.min(values.length - 1, 1 + Math.floor(((i * 37 % 101) / 100) ** 2 * 71)) : 0;
        const target = values && values.length ? Math.min(1, .75 * values[bin] / 255 + .25 * bass) : 0;
        const rise = Math.max(0, target - particle.energy);
        particle.pulse = Math.max(particle.pulse * Math.exp(-dt / .16), rise);
        particle.energy += (target - particle.energy) * (1 - Math.exp(-dt / (target > particle.energy ? .035 : .18)));
        particle.motion += dt * (.012 + particle.energy * .45 + particle.pulse * .6);
      });
    }

    function drawParticles(ctx, width, height, dpr, values, fallback, playing, connected) {
      const count = Math.min(particles.length, Math.max(90, Math.round(width * height / (dpr * dpr * 380))));
      // Keep the camera tilt bounded so the field never turns edge-on.
      const tiltX = Math.sin(particleTime * .13) * .10;
      const tiltY = Math.sin(particleTime * .10) * .14;
      const cosX = Math.cos(tiltX), sinX = Math.sin(tiltX);
      const cosY = Math.cos(tiltY), sinY = Math.sin(tiltY);
      const reflect = value => 1 - Math.abs(((value % 2 + 2) % 2) - 1);
      const nodes = [];
      ctx.save();

      for (let i = 0; i < count; i++) {
        const particle = particles[i];
        const time = particle.motion * (connected ? .7 : 1.15);
        const level = playing ? particle.energy : 0;
        const life = (particleTime * .12 + particle.phase / (Math.PI * 2)) % 1;
        const fade = Math.min(1, life / .3, (1 - life) / .7);
        const x = reflect(particle.x + particle.vx * time + Math.sin(particle.phase + time * particle.drift) * .04) - .5;
        const y = reflect(particle.y + particle.vy * time + Math.sin(particle.phaseY + time * particle.drift * .73) * .055) - .5;
        const depth = particle.z * .7 + Math.sin(particle.phaseY + time * .17) * .3;
        const rotatedX = x * cosY + depth * .2 * sinY;
        const rotatedZ = depth * .2 * cosY - x * sinY;
        const rotatedY = y * cosX - rotatedZ * sinX;
        const scale = 1 / (1.15 - (y * sinX + rotatedZ * cosX) * 1.1);
        const pulse = playing ? particle.pulse : 0;
        nodes.push({
          x: width * (.5 + rotatedX * .94),
          y: height * (.5 + rotatedY * .90),
          radius: (.7 + particle.size ** 2 * (connected ? 3.5 : 7)) * (1 + level * (connected ? 6.5 : 5) + pulse * 3) * (.5 + fade * .5) * scale * dpr,
          alpha: Math.min(1, .45 + (depth + 1) * .34) * Math.sqrt(fade) * (playing ? Math.min(1, .45 + level * .8 + pulse * .4) : .35),
          size: particle.size,
          level,
        });
      }
      if (connected) {
        const reach = Math.min(width * .22, 230 * dpr);
        ctx.lineWidth = .45 * dpr;
        // ponytail: bounded to 420 particles and 10 outgoing links; use a spatial grid if density grows.
        nodes.forEach((node, i) => {
          let links = 0;
          for (let j = i + 1; j < count && links < 10; j++) {
            const next = nodes[j];
            const distance = Math.hypot(node.x - next.x, node.y - next.y);
            if (distance >= reach) continue;
            ctx.strokeStyle = `rgba(113,229,119,${(1 - distance / reach) * (.18 + (node.level + next.level) * .45) * Math.sqrt(node.alpha * next.alpha)})`;
            ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(next.x, next.y); ctx.stroke();
            links++;
          }
        });
      }
      ctx.globalCompositeOperation = 'lighter';
      nodes.forEach((node, i) => {
        ctx.globalAlpha = node.alpha;
        if (connected && node.size > .8) {
          ctx.globalAlpha = node.alpha * .3;
          ctx.drawImage(particleSprites[7], node.x - node.radius * 2, node.y - node.radius * 2, node.radius * 4, node.radius * 4);
          ctx.globalAlpha = node.alpha;
        }
        const sprite = particleSprites[connected || i % 7 === 0 ? 0 : 1 + i % 6];
        ctx.drawImage(sprite, node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
        if (connected && node.size > .94 && node.level > .3) {
          ctx.strokeStyle = `rgba(183,255,187,${node.alpha * .6})`;
          ctx.lineWidth = .6 * dpr;
          const flare = node.radius * 2.5;
          ctx.beginPath();
          ctx.moveTo(node.x - flare, node.y); ctx.lineTo(node.x + flare, node.y);
          ctx.moveTo(node.x, node.y - flare); ctx.lineTo(node.x, node.y + flare);
          ctx.stroke();
        }
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
      else if (visualMode === 'constellation' || visualMode === 'particle') drawParticles(ctx, width, height, dpr, values, fallback, playing, visualMode === 'constellation');
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
      let min = 255;
      let max = 0;
      for (let i = 0; i < values.length; i += 1) {
        min = Math.min(min, values[i]);
        max = Math.max(max, values[i]);
        if (max - min > 4) return true;
      }
      return false;
    }

    function scheduleVisualizers() {
      if (!disposed && !frameId && !document.hidden) frameId = window.requestAnimationFrame(drawVisualizers);
    }

    function drawVisualizers(timestamp) {
      frameId = 0;
      if (disposed || document.hidden) return;
      const canvases = Array.from(document.querySelectorAll('[data-jazzradio-visualizer]')).filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!canvases.length) return;
      visualizerFrame += 1;
      const playing = currentPlaying();
      const particleDt = playing && particleLastTime ? Math.min(.05, (timestamp - particleLastTime) / 1000) : 1 / 60;
      if (playing) particleTime += particleDt;
      particleLastTime = playing ? timestamp : 0;
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
      if (isIOSDevice() && frequencyData) {
        frequencyData.fill(0);
        timeData.fill(128);
        channelData.forEach(data => data.fill(128));
        if (playing) readPCMAnalysis(pcmJob, particleDt);
        values = frequencyData;
        waveValues = timeData;
      }
      const hasData = hasUsableFrequencyData(values) || hasUsableTimeData(waveValues);
      updateParticles(particleDt, values, playing);
      if (playing && !hasData) { if (!silentSince) silentSince = performance.now(); }
      else silentSince = 0;
      const status = !playing ? (pcmJob ? 'waiting' : 'idle') : hasData ? 'live' : silentSince && performance.now() - silentSince > 3000 ? 'unavailable' : 'waiting';
      if (status !== analysisStatus) {
        analysisStatus = status;
        if (isIOSDevice()) state.waiting = !!pcmJob && !playing;
        if (status === 'unavailable') console.warn('[jazzradio] No audio analysis samples from this stream', {contextState: audioContext && audioContext.state, readyState: audio.readyState, src: audio.currentSrc});
        emit();
        if (isIOSDevice() && playing) refreshNowPlaying();
      }
      const left = playing && hasData ? vuLevel(channelData[0]) : 0;
      const right = playing && hasData ? vuLevel(channelData[1]) : 0;
      analogVuLeft = playing ? analogVuLeft + (left - analogVuLeft) * (left > analogVuLeft ? .35 : .12) : 0;
      analogVuRight = playing ? analogVuRight + (right - analogVuRight) * (right > analogVuRight ? .35 : .12) : 0;
      canvases.forEach(canvas => drawCanvas(canvas, values, waveValues, !hasData && !isIOSDevice(), playing, state.visualizerMode));
      if (isIOSDevice() && state.sessionStarted && performance.now() - lastDiagnosticAt > 1000) {
        lastDiagnosticAt = performance.now();
        emit();
      }
      if (playing || pcmJob) scheduleVisualizers();
    }

    function attachView(viewRoot, render) {
      const binding = { root: viewRoot, render };
      viewBindings.add(binding);
      viewRoot.dataset.jazzradioTheme = lightTheme ? 'light' : 'dark';
      applyColorTheme(viewRoot);
      render(snapshot());
      updateTrackProgress();
      syncFloatVisibility();
      return function detach() { viewBindings.delete(binding); syncFloatVisibility(); };
    }

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-theme', 'style'] });
    syncTheme();
    const observer = new MutationObserver(() => syncFloatVisibility());
    observer.observe(document.body, { childList: true, subtree: true });
    const listenTimer = window.setInterval(updateListenTime, 250);
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
    listen(window, 'pagehide', pause);

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
      window.clearTimeout(volumeControlsTimer);
      window.clearTimeout(noiseValueTimer);
      window.cancelAnimationFrame(frameId);
      window.clearInterval(listenTimer);
      window.clearInterval(metadataTimer);
      window.clearInterval(visibilityTimer);
      observer.disconnect();
      themeObserver.disconnect();
      barSizeObserver.disconnect();
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
        version: ENGINE_VERSION,
        serverVersion,
        noiseActive: !!noiseSource,
        noiseGain: noiseGain ? noiseGain.gain.value : 0,
        analysisStatus,
        contextState: audioContext ? audioContext.state : isIOSDevice() ? '미사용' : 'uninitialized',
        audioSessionType: isIOSDevice() && navigator.audioSession ? navigator.audioSession.type : '미지원',
        readyState: audio.readyState,
        mediaAttached: !!mediaSource,
        stream: audio.currentSrc,
        playbackRoute: isIOSDevice() ? 'pcm' : 'direct',
        analysisRoute: isIOSDevice() ? 'pcm' : 'media',
        pcmStatus: pcmJob ? pcmJob.status : pcmError ? 'error' : 'idle',
        pcmSamples: pcmJob ? pcmJob.samples : 0,
        pcmBufferedMs: pcmJob ? Math.max(0, (pcmJob.nextAt || 0) - pcmJob.context.currentTime) * 1000 : 0,
        pcmAnalysisTime: pcmJob ? pcmJob.analysisTime : null,
        pcmError,
        playbackError: lastPlaybackError,
        frequencyPeak: frequencyData ? Math.max(...frequencyData) : null,
        waveMin: timeData ? Math.min(...timeData) : null,
        waveMax: timeData ? Math.max(...timeData) : null,
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
      adjustVolume,
      toggleMuted,
      toggleVisualizer,
      toggleNoise,
      setNoiseLevel,
      setVisualizerMode,
      setColorTheme,
      setColorTone,
      setDockVisualizerPosition,
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
  const volumeControls = { volumeWrap, volume, volumeValue, volumeNote };
  const nowArtist = root.querySelector('#jazzradio-now-artist');
  const nowTitle = root.querySelector('#jazzradio-now-title');
  const nowQuality = root.querySelector('#jazzradio-now-quality');
  const controlDisc = root.querySelector('#jazzradio-control-disc');
  const visualizerModeButton = root.querySelector('#jazzradio-visualizer-mode');
  const mainVisualizer = root.querySelector('.jazzradio-visualizer');
  const visualizerModeLabelEl = root.querySelector('[data-jazzradio-visualizer-mode-label]');
  const coverImg = root.querySelector('#jazzradio-cover-img');
  const coverPlaceholder = root.querySelector('#jazzradio-cover-placeholder');

  const coverButton = root.querySelector('#jazzradio-cover');
  const recordLabel = root.querySelector('.jazzradio-turntable-label');
  let preferTurntable = false;

  function renderCover() {
    const src = coverImg.getAttribute('src');
    const available = !!src && coverImg.dataset.failedUrl !== src && coverImg.complete && coverImg.naturalWidth > 0;
    if (available && recordLabel.getAttribute('src') !== src) recordLabel.src = src;
    else if (!available) recordLabel.removeAttribute('src');
    recordLabel.hidden = !available || !recordLabel.complete || recordLabel.naturalWidth === 0;
    const turntable = preferTurntable || !available;
    coverImg.hidden = turntable;
    coverPlaceholder.hidden = !turntable;
    coverButton.disabled = !available;
    coverButton.setAttribute('aria-pressed', String(turntable));
    const label = available ? (turntable ? '앨범 커버로 전환' : '턴테이블로 전환') : '앨범 커버 없음 · 턴테이블';
    coverButton.setAttribute('aria-label', label);
    coverButton.title = label;
  }

  function applyMainArtwork(nowPlaying) {
    const src = String((nowPlaying && nowPlaying.album_art) || '');
    if (!src) coverImg.removeAttribute('src');
    else if (coverImg.getAttribute('src') !== src) {
      coverImg.dataset.failedUrl = '';
      coverImg.alt = nowPlaying && nowPlaying.artist ? `${nowPlaying.artist} 앨범 커버` : '앨범 커버';
      coverImg.src = src;
    }
    renderCover();
  }

  coverButton.onclick = () => { preferTurntable = !preferTurntable; renderCover(); };
  coverImg.addEventListener('load', renderCover);
  recordLabel.addEventListener('load', renderCover);
  recordLabel.addEventListener('error', () => { recordLabel.hidden = true; });
  coverImg.addEventListener('error', () => {
    coverImg.dataset.failedUrl = coverImg.getAttribute('src') || '';
    renderCover();
  });

  function renderStations(snap) {
    stationsEl.innerHTML = snap.stations.map((station) => `<button type="button" class="jazzradio-card${snap.selectedStation && snap.selectedStation.id === station.id ? ' active' : ''}" data-station-id="${escapeHtml(station.id)}" aria-label="${escapeHtml(station.name)} 선택" aria-current="${!!snap.selectedStation && snap.selectedStation.id === station.id}"></button>`).join('');
    stationsEl.querySelectorAll('.jazzradio-card').forEach((card) => {
      card.addEventListener('click', () => engine.selectStation(card.dataset.stationId, true));
    });
  }

  const infoPanel = root.querySelector('#jazzradio-info-panel');
  const infoOpen = root.querySelector('#jazzradio-info-open');
  let viewDetached = false;
  let infoTrigger = null;
  function openInfo(event) { infoTrigger = event.currentTarget; if (officialSite.hidden) websiteLoaded = false; if (!infoPanel.open) infoPanel.showModal(); loadArtistWebsite(engine.getState()); if (root.querySelector('#jazzradio-settings-tab').getAttribute('aria-selected') === 'true') requestBackgroundSettings(); }
  infoOpen.onclick = openInfo;
  root.querySelector('#jazzradio-info-close').onclick = () => infoPanel.close();
  infoPanel.addEventListener('close', () => { cancelBackgroundSettings(); if (infoTrigger && infoTrigger.isConnected) infoTrigger.focus(); });
  infoPanel.addEventListener('click', event => { if (event.target === infoPanel && event.clientX < infoPanel.getBoundingClientRect().left) infoPanel.close(); });
  const infoTabs = [...infoPanel.querySelectorAll('[role="tab"]')];
  function selectInfoTab(tab, focus) {
    infoTabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      root.querySelector(`#${item.getAttribute('aria-controls')}`).hidden = !selected;
    });
    infoPanel.scrollTop = 0;
    if (focus) tab.focus();
    if (tab.id === 'jazzradio-info-tab') loadArtistWebsite(engine.getState());
    else requestBackgroundSettings();
  }
  infoTabs.forEach((tab, index) => {
    tab.onclick = () => selectInfoTab(tab, false);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? infoTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + infoTabs.length) % infoTabs.length;
      selectInfoTab(infoTabs[next], true);
    };
  });
  const colorInput = root.querySelector('#jazzradio-theme-color');
  const colorValue = root.querySelector('#jazzradio-theme-color-value');
  const colorPresets = [...root.querySelectorAll('[data-jazzradio-color]')];
  colorPresets.forEach(button => { button.onclick = () => {
    engine.setColorTheme(button.dataset.jazzradioColor);
    if (!button.dataset.jazzradioColor) engine.setColorTone(100);
  }; });
  colorInput.oninput = colorInput.onchange = () => engine.setColorTheme(colorInput.value);
  const colorTone = root.querySelector('#jazzradio-color-tone');
  const colorToneValue = root.querySelector('#jazzradio-color-tone-value');
  const dockPosition = root.querySelector('#jazzradio-dock-viz-position');
  colorTone.oninput = colorTone.onchange = () => engine.setColorTone(colorTone.value);
  dockPosition.onchange = () => engine.setDockVisualizerPosition(dockPosition.value);
  function renderColorSettings(snap) {
    const color = snap.colorTheme || '#54b2dc';
    if (colorInput.value !== color) colorInput.value = color;
    const label = snap.colorTheme ? snap.colorTheme.toUpperCase() : '기본 색상';
    if (colorValue.textContent !== label) colorValue.textContent = label;
    colorPresets.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.jazzradioColor === snap.colorTheme)));
    if (colorTone.value !== String(snap.colorTone)) colorTone.value = String(snap.colorTone);
    colorTone.parentElement.style.setProperty('--jr-volume', `${snap.colorTone}%`);
    const toneLabel = `${snap.colorTone}%`;
    if (colorToneValue.textContent !== toneLabel) colorToneValue.textContent = toneLabel;
    if (dockPosition.value !== snap.dockVisualizerPosition) dockPosition.value = snap.dockVisualizerPosition;
  }
  const backgroundForm = root.querySelector('#jazzradio-background-form');
  const backgroundKey = root.querySelector('#jazzradio-background-key');
  const backgroundTerms = root.querySelector('#jazzradio-background-terms');
  const backgroundSave = root.querySelector('#jazzradio-background-save');
  const backgroundDelete = root.querySelector('#jazzradio-background-delete');
  const settingsStatus = root.querySelector('#jazzradio-background-settings-status');
  let backgroundSettings = null, settingsRequest = null;
  function renderBackgroundSettings() {
    const editable = !!backgroundSettings && backgroundSettings.can_edit;
    if (!editable) backgroundKey.value = '';
    backgroundForm.hidden = !editable;
    [backgroundKey, backgroundTerms, backgroundSave, backgroundDelete].forEach(input => { input.disabled = !editable || !!settingsRequest || viewDetached; });
    backgroundForm.setAttribute('aria-busy', String(!!settingsRequest));
    if (!backgroundSettings) return;
    root.querySelector('#jazzradio-background-source').textContent = {detail_studio:'Detail Studio 설정 사용 중', jazzradio:'Jazzradio 자체 설정 사용 중', default:'기본 사진 사용 중'}[backgroundSettings.source];
    root.querySelector('#jazzradio-background-key-state').textContent = backgroundSettings.key_saved ? '자체 Access Key가 저장되어 있습니다.' : '저장된 자체 Access Key가 없습니다.';
  }
  function cancelBackgroundSettings() {
    backgroundKey.value = '';
    if (settingsRequest) settingsRequest.abort();
    settingsRequest = null;
    renderBackgroundSettings();
  }
  async function requestBackgroundSettings(operation) {
    if (viewDetached || settingsRequest || operation && (!backgroundSettings || !backgroundSettings.can_edit)) return;
    if (operation === 'save' && !backgroundKey.value.trim() && !backgroundSettings.key_saved) {
      settingsStatus.textContent = 'Unsplash Access Key를 입력해 주세요.';
      backgroundKey.focus();
      return;
    }
    const request = new AbortController();
    settingsRequest = request;
    settingsStatus.textContent = operation ? '배경 설정을 저장하고 있습니다.' : '배경 설정을 확인하고 있습니다.';
    renderBackgroundSettings();
    const timeout = window.setTimeout(() => request.abort(), 12000);
    try {
      const context = operation === 'save' ? {operation, unsplash_key: backgroundKey.value.trim(), unsplash_terms: backgroundTerms.checked} : {operation};
      const response = await fetch(operation ? '/api/media/context-menu/book/plugins/action' : `${DATA_URL}&background_settings=1`, operation ? {
        method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json', 'X-Jazzradio-Settings':'1'},
        body:JSON.stringify({type:'general', plugin_id:'jazzradio', action_id:'background_settings', context}), signal:request.signal,
      } : {credentials:'same-origin', cache:'no-store', signal:request.signal});
      if (!response.ok) throw new Error('settings request failed');
      const data = await response.json();
      if (viewDetached || !root.isConnected || settingsRequest !== request) return;
      if (request.signal.aborted) throw new Error('settings request timed out');
      const settings = data && data.background_settings;
      if (!data.success || !settings || typeof settings.can_edit !== 'boolean' || typeof settings.key_saved !== 'boolean' || typeof settings.terms !== 'boolean' || !['detail_studio', 'jazzradio', 'default'].includes(settings.source)) {
        if (operation) throw new Error('settings response invalid');
        backgroundSettings = null;
        settingsStatus.textContent = '배경 설정을 사용하려면 Jazzradio 서버 플러그인을 업데이트해 주세요.';
        return;
      }
      backgroundSettings = settings;
      backgroundTerms.checked = settings.terms;
      if (operation) {
        backgroundKey.value = '';
        settingsStatus.textContent = operation === 'delete' ? '자체 설정을 삭제했습니다.' : '배경 설정을 저장했습니다.';
        if (settings.source === 'detail_studio') settingsStatus.textContent += ' Detail Studio 설정을 먼저 사용하며 자체 설정은 대기합니다.';
        loadBackground(false);
      } else settingsStatus.textContent = settings.can_edit ? '' : '배경 설정은 관리자만 변경할 수 있습니다.';
    } catch (_) {
      if (viewDetached || !root.isConnected || settingsRequest !== request) return;
      if (!operation) backgroundSettings = null;
      settingsStatus.textContent = operation ? '배경 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '배경 설정을 확인하지 못했습니다. 잠시 후 설정 탭을 다시 열어 주세요.';
    } finally {
      window.clearTimeout(timeout);
      if (settingsRequest === request) { settingsRequest = null; renderBackgroundSettings(); }
    }
  }
  backgroundForm.onsubmit = event => { event.preventDefault(); requestBackgroundSettings('save'); };
  backgroundDelete.onclick = () => requestBackgroundSettings('delete');
  const officialSite = root.querySelector('#jazzradio-official-site');
  let websiteKey = '', websiteLoaded = false, websiteRequest = null, websiteStatus = '미조회';
  function loadArtistWebsite(snap) {
    const np = snap.nowPlaying;
    const artist = np && np.available && !np.stale ? String(np.artist || '').trim() : '';
    const key = artist ? `${snap.selectedStation.id}|${artist}` : '';
    if (key !== websiteKey) {
      if (websiteRequest) websiteRequest.abort();
      websiteRequest = null;
      websiteKey = key;
      websiteLoaded = false;
      websiteStatus = '미조회';
      officialSite.hidden = true;
      officialSite.removeAttribute('href');
    }
    if (!key || !infoPanel.open || websiteLoaded || websiteRequest) return;
    const request = new AbortController();
    websiteRequest = request;
    websiteStatus = '조회 중';
    const timeout = window.setTimeout(() => request.abort(), 20000);
    fetch(`${DATA_URL}&artist_site=1&station=${encodeURIComponent(snap.selectedStation.id)}`, {credentials:'same-origin', cache:'no-store', signal:request.signal})
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then(data => {
        if (request.signal.aborted || key !== websiteKey || !root.isConnected) return;
        if (!data || !data.success || !Object.prototype.hasOwnProperty.call(data, 'official_site')) { websiteStatus = '서버 업데이트 필요'; return; }
        if (data.artist !== artist) { websiteStatus = '곡 정보 갱신 대기'; return; }
        websiteStatus = {found:'확인', not_found:'등록 링크 없음', ambiguous:'아티스트 식별 불확실', unavailable:'연결 실패', no_artist:'아티스트 정보 없음'}[data.official_site_status] || '등록 링크 없음';
        if (!data.official_site) return;
        const url = new URL(data.official_site);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { websiteStatus = '유효하지 않은 링크'; return; }
        officialSite.href = `${url.origin}/`;
        officialSite.querySelector('small').textContent = url.hostname.replace(/^www\./, '');
        officialSite.setAttribute('aria-label', `${artist} 공식 홈페이지 · MusicBrainz 등록 링크`);
        officialSite.hidden = false;
        websiteStatus = '확인';
      })
      .catch(error => { if (key === websiteKey) websiteStatus = error.name === 'AbortError' ? '시간 초과' : '연결 실패'; })
      .finally(() => { window.clearTimeout(timeout); if (websiteRequest === request) { websiteRequest = null; websiteLoaded = true; if (root.isConnected) renderView(engine.getState()); } });
  }

  function renderTrackInfo(snap) {
    const np = snap.nowPlaying && snap.nowPlaying.available ? snap.nowPlaying : null;
    const query = np ? [np.artist, np.title].filter(Boolean).join(' ') : '';
    root.querySelector('#jazzradio-info-title').textContent = np ? np.title || np.raw || '곡명 정보 없음' : '현재 곡 정보 없음';
    const artist = root.querySelector('#jazzradio-info-artist');
    artist.textContent = np ? np.artist || '아티스트 정보 없음' : '';
    const artistUrl = np && safeLink(np.artist_url, ['music.apple.com', 'itunes.apple.com']);
    if (artistUrl) artist.href = artistUrl; else artist.removeAttribute('href');
    root.querySelector('#jazzradio-info-album').textContent = np ? np.album_name || '' : '';
    const img = root.querySelector('#jazzradio-info-cover');
    const cover = np && safeLink(np.album_art);
    if (cover && img.getAttribute('src') !== cover) { img.src = cover; img.hidden = false; }
    if (!cover) { img.hidden = true; img.removeAttribute('src'); }
    img.onerror = () => { img.hidden = true; };
    const sources = root.querySelector('#jazzradio-info-sources');
    [['mb', 'metadata_source_url'], ['caa', 'cover_source_url']].forEach(([name, field]) => {
      const link = sources.querySelector(`[data-jazzradio-source="${name}"]`);
      const href = np && safeLink(np[field], ['musicbrainz.org']);
      link.hidden = !href;
      if (href) link.href = href; else link.removeAttribute('href');
    });
    sources.hidden = !Array.from(sources.querySelectorAll('a')).some(link => !link.hidden);
    const facts = [['방송국', snap.selectedStation && snap.selectedStation.name], ['앨범', np && np.album_name], ['장르', np && np.genre], ['발매', np && np.release_date && String(np.release_date).slice(0, 10)], ['수록곡 길이', np && np.duration_ms > 0 && elapsedText(np.duration_ms / 1000)]];
    const dl = root.querySelector('#jazzradio-info-facts');
    dl.replaceChildren();
    facts.filter(([,value]) => value).forEach(([key,value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = value; dl.append(dt,dd); });
    const apple = root.querySelector('[data-jazzradio-service="apple"]');
    const exact = np && safeLink(np.track_url, ['music.apple.com', 'itunes.apple.com']);
    const urls = {apple: exact || `https://music.apple.com/search?term=${encodeURIComponent(query)}`, spotify: `https://open.spotify.com/search/${encodeURIComponent(query)}`, youtube: `https://music.youtube.com/search?q=${encodeURIComponent(query)}`};
    root.querySelectorAll('[data-jazzradio-service]').forEach(link => {
      if (query) { link.href = urls[link.dataset.jazzradioService]; link.removeAttribute('aria-disabled'); }
      else { link.removeAttribute('href'); link.setAttribute('aria-disabled','true'); }
    });
    apple.title = exact ? 'Apple Music 곡 페이지' : 'Apple Music에서 현재 곡 검색';
    loadArtistWebsite(snap);
    root.querySelector('#jazzradio-info-note').textContent = np ? '가수와 곡명을 기준으로 음악 서비스에서 찾아보세요.' : '방송국에서 곡 정보를 보내면 아티스트와 앨범 자료가 여기에 표시됩니다.';
  }
  function selectRelativeStation(direction) {
    const snap = engine.getState(), count = snap.stations.length;
    if (!count) return;
    const index = snap.stations.findIndex(item => snap.selectedStation && item.id === snap.selectedStation.id);
    engine.selectStation(snap.stations[(Math.max(0,index) + direction + count) % count].id, true);
  }
  root.querySelector('#jazzradio-station-prev').onclick = () => selectRelativeStation(-1);
  root.querySelector('#jazzradio-station-next').onclick = () => selectRelativeStation(1);
  root.querySelector('.jazzradio-brand').onclick = event => { event.preventDefault(); root.scrollIntoView({behavior:'smooth',block:'start'}); };
  const background = root.querySelector('#jazzradio-background');
  const credit = root.querySelector('#jazzradio-photo-credit');
  function showBackground(photo) {
    const url = safeLink(photo && photo.url, ['images.unsplash.com']);
    if (!url) return;
    background.src = url;
    const source = safeLink(photo.source_url, ['unsplash.com']);
    const creator = root.querySelector('#jazzradio-photo-creator');
    const creatorUrl = safeLink(photo.creator_url, ['unsplash.com']);
    credit.firstElementChild.textContent = photo.creator ? 'Photo by ' : '';
    creator.textContent = photo.creator || 'Photo';
    if (creatorUrl) creator.href = creatorUrl; else creator.removeAttribute('href');
    if (source) { root.querySelector('#jazzradio-photo-source').href = source; credit.hidden = false; }
  }
  showBackground(DEFAULT_BACKGROUND);
  const backgroundButton = root.querySelector('#jazzradio-background-refresh');
  const backgroundStatus = root.querySelector('#jazzradio-background-status');
  let backgroundStatusTimer = null, backgroundRequest = null;
  function showBackgroundStatus(text) {
    window.clearTimeout(backgroundStatusTimer);
    backgroundStatus.textContent = text;
    backgroundStatus.hidden = false;
    backgroundStatusTimer = window.setTimeout(() => { backgroundStatus.hidden = true; backgroundStatus.textContent = ''; }, 4000);
  }
  async function loadBackground(force) {
    if (viewDetached || force && backgroundRequest) return;
    if (backgroundRequest) backgroundRequest.abort();
    backgroundButton.disabled = true;
    backgroundButton.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    backgroundRequest = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${DATA_URL}&background=1${force ? '&refresh=1' : ''}`, {credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('background request failed');
      const data = await response.json();
      if (viewDetached || !root.isConnected || controller.signal.aborted || backgroundRequest !== controller) return;
      if (!data.success || !data.background || typeof data.background.url !== 'string') throw new Error('background response invalid');
      showBackground(data.background.source === 'default' || !safeLink(data.background.url, ['images.unsplash.com']) ? DEFAULT_BACKGROUND : data.background);
      if (force) {
        const photo = data.background;
        showBackgroundStatus(photo.reason === 'cooldown' ? `${photo.retry_after || 60}초 후 다시 변경할 수 있습니다.` : photo.reason ? '사진을 변경하지 못했습니다. Unsplash 설정이나 연결 상태를 확인해 주세요.' : '배경 사진을 변경했습니다. 연속 변경은 1분 간격입니다.');
      }
    } catch (_) {
      if (force && !viewDetached && root.isConnected && backgroundRequest === controller) showBackgroundStatus('사진을 불러오지 못해 현재 배경을 유지합니다.');
    } finally {
      window.clearTimeout(timeout);
      if (backgroundRequest === controller) {
        backgroundRequest = null;
        backgroundButton.disabled = false;
        backgroundButton.removeAttribute('aria-busy');
      }
    }
  }
  backgroundButton.onclick = () => loadBackground(true);
  loadBackground(false);

  let renderedStationSignature = '';
  function renderView(snap) {
    renderColorSettings(snap);
    const station = snap.selectedStation;
    const np = snap.nowPlaying;
    root.querySelectorAll('[data-jazzradio-elapsed]').forEach(el => { const text = elapsedText(snap.elapsedSeconds); if (el.textContent !== text) el.textContent = text; });
    root.querySelector('.jazzradio-player').classList.toggle('is-playing', snap.playing);
    const vizToggle = root.querySelector('#jazzradio-visualizer-toggle');
    vizToggle.setAttribute('aria-pressed', String(snap.visualizerEnabled));
    vizToggle.setAttribute('aria-expanded', String(snap.visualizerEnabled));
    vizToggle.title = snap.visualizerEnabled ? '비주얼라이저 끄기' : '비주얼라이저 켜기';
    const vizPanel = root.querySelector('#jazzradio-viz-panel');
    vizPanel.classList.toggle('is-open', snap.visualizerEnabled);
    vizPanel.inert = !snap.visualizerEnabled;
    vizPanel.setAttribute('aria-hidden', String(!snap.visualizerEnabled));
    root.querySelector('#jazzradio-equalizer').hidden = !snap.visualizerEnabled;
    const muteButton = root.querySelector('#jazzradio-mute');
    muteButton.setAttribute('aria-pressed', String(snap.muted));
    muteButton.setAttribute('aria-label', snap.muted ? '음소거 해제' : '음소거');
    muteButton.title = snap.muted ? '음소거 해제' : '음소거';
    muteButton.innerHTML = `<i class="fa-solid fa-volume-${snap.muted ? 'xmark' : 'low'}" aria-hidden="true"></i>`;
    root.querySelector('#jazzradio-on-air').textContent = snap.waiting ? 'CONNECTING' : snap.playing ? '● ON AIR' : 'STANDBY';
    root.querySelector('#jazzradio-on-air').classList.toggle('is-paused', !snap.playing);
    if (station) {
      root.querySelector('#jazzradio-station-name').innerHTML = ({relaxingjazz: 'Relaxing<br><em>Jazz.</em>', 'radio-swiss-jazz': 'Radio Swiss<br><em>Jazz.</em>', jazz24: 'Jazz<em>24.</em>'})[station.id] || escapeHtml(station.name);
      root.querySelector('#jazzradio-station-subtitle').textContent = station.subtitle || '';
      root.querySelector('#jazzradio-station-description').textContent = station.description || '';
      root.querySelector('#jazzradio-station-quality').textContent = station.quality || 'LIVE';
      root.querySelector('#jazzradio-station-eyebrow').textContent = station.id === 'relaxingjazz' ? 'LIVE FROM SAINT LUCIA' : station.id === 'radio-swiss-jazz' ? 'LIVE FROM SWITZERLAND' : 'LIVE FROM SEATTLE';
      root.querySelector('#jazzradio-station-index').textContent = `${String(snap.stations.indexOf(station) + 1).padStart(2, '0')} / ${String(snap.stations.length).padStart(2, '0')}`;
    }
    root.querySelector('#jazzradio-now-album').textContent = np && np.available ? np.album_name || '앨범 정보 없음' : '잠시 후 현재 곡 정보가 표시됩니다.';
    renderTrackInfo(snap);
    const signature = snap.stations.map((s) => s.id).join('|') + '::' + (station ? station.id : '');
    if (signature !== renderedStationSignature) {
      renderedStationSignature = signature;
      renderStations(snap);
    } else {
      stationsEl.querySelectorAll('.jazzradio-card').forEach((card) => card.classList.toggle('active', !!station && card.dataset.stationId === station.id));
    }

    playButton.disabled = !station;
    const canPause = snap.playing || (isIOSDevice() && snap.waiting);
    playButton.innerHTML = canPause ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
    playButton.setAttribute('aria-label', canPause ? '일시정지' : '재생');
    controlDisc.classList.toggle('playing', snap.playing);
    controlDisc.setAttribute('aria-pressed', String(snap.noiseEnabled));
    controlDisc.title = snap.noiseEnabled ? 'LP 노이즈 끄기' : 'LP 노이즈 켜기';
    const power = root.querySelector('[data-jazzradio-power]');
    power.hidden = !snap.visualizerEnabled || snap.visualizerMode !== 'tube';
    power.disabled = !station;
    power.setAttribute('aria-pressed', String(snap.playing));
    power.setAttribute('aria-label', snap.playing ? '라디오 일시정지' : '라디오 재생');
    const analysisNote = root.querySelector('[data-jazzradio-analysis-note]');
    let pcmLink = root.querySelector('[data-jazzradio-pcm-link]');
    if (!pcmLink) {
      pcmLink = document.createElement('a');
      pcmLink.dataset.jazzradioPcmLink = '';
      pcmLink.className = 'jazzradio-analysis-note';
      pcmLink.href = `${DATA_URL}&pcm_test=1`;
      pcmLink.target = '_blank';
      pcmLink.rel = 'noopener';
      pcmLink.textContent = '5초 PCM 진단 열기';
      analysisNote.before(pcmLink);
    }
    pcmLink.hidden = !isIOSDevice();
    const diagnostic = engine.getDiagnostics();
    const route = diagnostic.analysisRoute === 'pcm' ? `PCM 분석 ${diagnostic.pcmStatus}` : '기본 분석';
    analysisNote.textContent = `앱 ${diagnostic.version} / 서버 ${diagnostic.serverVersion} · ${diagnostic.playbackRoute === 'pcm' ? '단일 PCM 재생' : '방송국 직접 재생'}(${diagnostic.playbackRoute === 'pcm' ? 'Web Audio 출력' : diagnostic.mediaAttached ? 'Web Audio 출력' : '기본 오디오 출력'}) · ${route} · 분석 ${diagnostic.analysisStatus} · Context ${diagnostic.contextState}${isIOSDevice() ? ` · Audio Session ${diagnostic.audioSessionType}` : ''} · 주파수 ${diagnostic.frequencyPeak} / 파형 ${diagnostic.waveMin}~${diagnostic.waveMax} · 공식 홈페이지 ${websiteStatus} · LP 노이즈 ${snap.noiseEnabled ? `켜짐 ${snap.noiseLevel}%` : '꺼짐'}${diagnostic.pcmError ? ` · PCM 오류 ${diagnostic.pcmError}` : ''}${diagnostic.playbackError ? ` · 재생 오류 ${diagnostic.playbackError}` : ''}`;
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

    stationsEl.querySelectorAll('.jazzradio-card').forEach(card => { card.setAttribute('aria-current', String(!!station && card.dataset.stationId === station.id)); });
    messageEl.textContent = snap.error || '';
    messageEl.hidden = !snap.error;

    renderVolumeControls(volumeControls, snap);
  }

  const detachView = engine.attachView(root, renderView);
  const viewObserver = new MutationObserver(() => { if (!root.isConnected) root.__jazzradioDetach(); });
  viewObserver.observe(document.body, {childList:true, subtree:true});
  root.__jazzradioDetach = () => {
    if (viewDetached) return;
    viewDetached = true;
    viewObserver.disconnect();
    cancelBackgroundSettings();
    if (backgroundRequest) backgroundRequest.abort();
    if (websiteRequest) websiteRequest.abort();
    window.clearTimeout(backgroundStatusTimer);
    backgroundStatus.hidden = true;
    backgroundStatus.textContent = '';
    detachView();
  };
  playButton.onclick = () => engine.toggle();
  controlDisc.onclick = () => engine.toggleNoise();
  volume.oninput = () => engine.adjustVolume(volume.value);
  root.querySelector('#jazzradio-mute').onclick = () => engine.toggleMuted();
  root.querySelector('#jazzradio-visualizer-toggle').onclick = () => engine.toggleVisualizer();
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
        engine.setStations(data.stations, data.version);
      })
      .catch((error) => {
        console.error('[jazzradio] station load failed:', error);
        messageEl.textContent = '라디오 방송국 목록을 불러오지 못했습니다. BookOasis를 새로고침해 주세요.';
        messageEl.hidden = false;
      });
  }

  loadStations();
})();
