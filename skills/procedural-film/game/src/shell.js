/*
 * shell.js : the game page (docs/game-spec.md 3.2, 3.3 and 11). Owner: P6.
 *
 * The page around the console: the TV (the 320x180 native buffer presented through src/crt.js), the
 * chrome row under it (help, toasts, the sound prompt, the input display), the touch pad on phones and
 * tablets, and a polite live region for screen readers. It carries the input handling (the
 * key merge, the latch, suppress, the gamepad poll, the touch pad, live sound).
 *
 * Shell states: boot -> title (with options and controls over it) -> game <-> paused, and title -> demo.
 * The menus are pure state machines (src/game/50-menu.js); the console is FILM.game.create; the clock is
 * GAME.clock (src/game/45-clock.js), advanced only by the requestAnimationFrame stamp. Every animation
 * frame runs 0 to 5 fixed 60 Hz steps and draws once, only when it stepped (or the output changed).
 *
 * Keys: the bindings in the save (two slots per button, remappable on the CONTROLS screen), plus the
 * fixed keys P and Escape (pause or resume), F (fullscreen), C (CRT or clean), M (mute), I (input
 * display). Gamepads with the standard mapping: D-pad or left stick, A = buttons 1 and 3, B = 0 and 2,
 * START 9, SELECT 8. Touch: an 8-way D-pad, B and A (a finger between them presses both), SELECT,
 * START, PAUSE and FULL.
 *
 * External pauses (P, Escape, a hidden tab, a lost focus, a gamepad unplugged) reach the engine as a START
 * press on a pausable frame, so a recorded tape replays them. The engine never touches storage: the save
 * (localStorage GAME.CONFIG.saveKey) is derived here from the console's events.
 *
 * Tools: FILM.shell.stats (read-only getters), and with ?proof=1 FILM.shell.proof { feed(tape), fast(n),
 * idle(frames), snap(), pixels(), record() }. ?touch=1 or 0 forces the touch pad; ?clean=1 opens clean.
 */
(function () {
  'use strict';

  const FILM = window.FILM;
  if (!FILM || !FILM.game || typeof FILM.game.create !== 'function' || !FILM.__game || !FILM.__game.clock || !FILM.__game.menu) return;
  const GAME = FILM.__game;
  const MENU = GAME.menu;
  const BTN = FILM.game.BUTTONS;
  const params = new URLSearchParams(window.location.search);
  const PROOF = params.get('proof') === '1';

  const CONFIG = GAME.CONFIG;
  const SAVE_KEY = CONFIG.saveKey;
  const TOAST_FRAMES = 150;
  const CHROME_H = 28;
  // shown in the title, menu and demo help rows only when the game sets one (GAME.CONFIG.legal)
  const LEGAL = CONFIG.legal || '';
  const LEGAL_ROW = LEGAL ? [['', LEGAL]] : [];
  const PAD_H = 240; // the height the portrait touch pad keeps under the chrome
  const P_TTL = 45; // a P or Escape pause waits this many steps for a pausable frame
  const LEVELS = () => (Array.isArray(GAME.GAME_ORDER) && GAME.GAME_ORDER.length ? GAME.GAME_ORDER.slice() : CONFIG.order.slice());

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  const S = {
    state: 'boot', // boot | title | demo | game | paused (the menus' own screens refine title and paused)
    title: null, // the title console (FILM.game.create, stepped with 0 under the title menus)
    game: null, // the game console
    gameOpts: null,
    demo: null,
    demoT: 0,
    menu: null, // GAME.menu state (title and paused)
    clock: GAME.clock.make(),
    fast: 0,
    // input
    held: new Set(), // keyboard codes held
    codeBtn: {}, // code -> button bit (from the bindings)
    touch: 0,
    pad: 0,
    padPrev: 0,
    pads: 0, // connected gamepads last poll
    latch: 0,
    suppress: 0,
    prevMask: 0, // the merged mask of the last step
    lastSent: 0, // the byte the game console saw last
    buttons: 0, // what the console or menu saw on the last step
    waitRelease: false,
    first: false, // the game console's first step sends START
    pauseReq: null, // { ttl } (ttl -1: until applied)
    resumeReq: false,
    // counters
    steps: 0,
    rafs: 0,
    rate: 0,
    rateT0: null,
    rateN0: 0,
    runBest: 0,
    presented: '',
    dirty: true,
    warmed: false,
    warmN: 24, // names GAME.warmStep builds this animation frame (warm())
    lastStamp: null,
    // audio
    actx: null,
    gain: null,
    snd: null,
    lastSong: null,
    // page
    ui: null,
    helpMode: '', // the engine mode the help row was last drawn for
    touchOn: false,
    padHidden: false,
    toast: null, // { text, t }
    sayQ: [],
    sayAt: -1e9,
    mounted: 0,
    // proof
    feed: null,
    rec: null,
  };

  // ---------------------------------------------------------------------------------------------
  // The save (U9): validated per field; storage failures keep it in memory and show SAVE OFF
  // ---------------------------------------------------------------------------------------------
  let save = null;
  let saveOk = true;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }
  function defaults() {
    const tokens = {};
    for (const id of LEVELS()) tokens[id] = 0;
    return {
      v: 1, hi: 0, reach: CONFIG.firstLevel, cleared: false, tokens,
      settings: { feel: 'modern', crt: 'on', vol: 8, mute: false, input: false, flash: reducedMotion() ? 'reduced' : 'full', keys: clone(MENU.DEFAULT_KEYS) },
    };
  }
  const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  function validate(raw) {
    const d = defaults();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return d;
    if (isInt(raw.hi, 0, 9999999)) d.hi = raw.hi;
    if (typeof raw.reach === 'string' && LEVELS().indexOf(raw.reach) >= 0) d.reach = raw.reach;
    if (typeof raw.cleared === 'boolean') d.cleared = raw.cleared;
    if (raw.tokens && typeof raw.tokens === 'object') for (const id in d.tokens) if (isInt(raw.tokens[id], 0, 7)) d.tokens[id] = raw.tokens[id];
    const rs = raw.settings;
    if (rs && typeof rs === 'object') {
      const ds = d.settings;
      if (rs.feel === 'modern' || rs.feel === 'nes') ds.feel = rs.feel;
      if (rs.crt === 'on' || rs.crt === 'off') ds.crt = rs.crt;
      if (isInt(rs.vol, 0, 10)) ds.vol = rs.vol;
      if (typeof rs.mute === 'boolean') ds.mute = rs.mute;
      if (typeof rs.input === 'boolean') ds.input = rs.input;
      if (rs.flash === 'full' || rs.flash === 'reduced') ds.flash = rs.flash;
      if (rs.keys && typeof rs.keys === 'object') {
        const k = {};
        for (const a of MENU.ACTIONS) {
          const v = rs.keys[a];
          k[a] = Array.isArray(v) && v.length === 2 && v.every((c) => MENU.bindable(c)) ? [v[0], v[1]] : ds.keys[a].slice();
        }
        const all = MENU.ACTIONS.flatMap((a) => k[a]);
        if (new Set(all).size === all.length) ds.keys = k; // a key bound twice: the defaults
      }
    }
    return d;
  }
  function loadSave() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(SAVE_KEY);
    } catch (e) {
      saveOk = false;
    }
    let parsed = null;
    if (raw != null) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null; // unparseable: a fresh save
      }
    }
    save = validate(parsed);
  }
  function writeSave() {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
      if (!saveOk) saveOk = true;
    } catch (e) {
      if (saveOk) toast('SAVE OFF');
      saveOk = false;
    }
  }
  function recordHi() {
    const hi = Math.max(save.hi, S.runBest | 0);
    if (hi !== save.hi) {
      save.hi = hi;
      writeSave();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------------------------
  const CSS = [
    'html,body{margin:0;height:100%;background:#000;overflow:hidden;overscroll-behavior:none}',
    'body{display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;',
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);',
    '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;',
    'font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8b877f;cursor:default}',
    '#tv{display:block;flex:none;background:#000;touch-action:none;outline:none}',
    '#chrome{flex:none;box-sizing:border-box;height:28px;display:flex;align-items:center;gap:10px;padding:0 4px}',
    '#help{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.04em}',
    '#help span{margin-right:12px}',
    '#help b{display:inline-block;min-width:9px;padding:2px 4px 1px;margin-right:4px;border:1px solid #3b3934;border-bottom-width:2px;',
    'border-radius:3px;color:#e9e3d6;font-weight:600;text-align:center}',
    '#note{flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f1ebdf;letter-spacing:.16em;',
    'transition:opacity .25s;opacity:0}',
    '#note.on{opacity:1}',
    '#note.gate{color:#e8e0cf;animation:game-blink 1.2s steps(1,end) infinite}',
    '@keyframes game-blink{0%{opacity:1}62%{opacity:.25}}',
    '#slot{flex:1 1 0;display:flex;justify-content:flex-end;align-items:center;min-width:0}',
    'body.touch #help{display:none}',
    'body.touch #slot{flex:0 0 auto}',
    'body.touch #note{flex:1 1 0;text-align:center}',
    '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;white-space:nowrap;clip-path:inset(50%)}',
    // the input display: a small NES controller lit by the buttons each step sends
    '#nes{display:none;align-items:center;gap:6px;pointer-events:none}',
    '#nes.on{display:flex}',
    '#nes .cap{font-size:9px;letter-spacing:.16em;color:#6d6a64}',
    '#nes .shell{width:92px;height:24px;box-sizing:border-box;padding:2px;border-radius:3px;background:#c4c2bd;box-shadow:inset 0 -2px 0 #9d9b96}',
    '#nes .face{position:relative;width:100%;height:100%;border-radius:2px;background:#17171a}',
    '#nes i{position:absolute;display:block;background:#2e2e33}',
    '#nes .v{left:9px;top:2px;width:6px;height:16px;border-radius:1px}',
    '#nes .h{left:4px;top:7px;width:16px;height:6px;border-radius:1px}',
    '#nes .u{left:9px;top:2px;width:6px;height:5px;background:none}',
    '#nes .d{left:9px;top:13px;width:6px;height:5px;background:none}',
    '#nes .l{left:4px;top:7px;width:5px;height:6px;background:none}',
    '#nes .r{left:15px;top:7px;width:5px;height:6px;background:none}',
    '#nes .mid{left:26px;top:5px;width:28px;height:10px;border-radius:2px;background:#8f8d88}',
    '#nes .se{left:29px;top:8px;width:10px;height:4px;border-radius:2px;background:#2e2e33}',
    '#nes .st{left:42px;top:8px;width:10px;height:4px;border-radius:2px;background:#2e2e33}',
    '#nes .bb,#nes .ba{top:4px;width:12px;height:12px;border-radius:2px;background:#bdbbb6}',
    '#nes .bb{left:58px}#nes .ba{left:72px}',
    '#nes .b,#nes .a{top:6px;width:8px;height:8px;border-radius:50%;background:#9c2a20}',
    '#nes .b{left:60px}#nes .a{left:74px}',
    '#nes i.lit{background:#f4f1ea;box-shadow:0 0 5px rgba(255,248,230,.85)}',
    '#nes .b.lit,#nes .a.lit{background:#ff5a45;box-shadow:0 0 6px rgba(255,90,69,.95)}',
    // the touch pad (portrait: under the chrome, in the page flow): the TV, the chrome and the pad sit
    // together, centred in the page, so no dead gap opens between the picture and the controls
    '#pad{flex:none;box-sizing:border-box;width:100%;max-width:520px;min-height:' + PAD_H + 'px;padding:10px 14px 14px;',
    'display:flex;flex-direction:column;justify-content:flex-end;gap:16px;touch-action:none;color:rgba(255,255,255,.66);',
    'font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em}',
    'body.padoff #pad{display:none}',
    '#pad *{touch-action:none}',
    '#pad .row{display:flex;align-items:center;justify-content:space-between}',
    '#pad .dpad{position:relative;width:144px;height:144px;flex:none}',
    '#pad .dpad>div{position:absolute}',
    '#pad .x{inset:0;background:rgba(255,255,255,.14);clip-path:polygon(33% 0,67% 0,67% 33%,100% 33%,100% 67%,67% 67%,67% 100%,33% 100%,33% 67%,0 67%,0 33%,33% 33%)}',
    '#pad .x::after{content:"";position:absolute;left:43%;top:43%;width:14%;height:14%;border-radius:50%;background:rgba(0,0,0,.35)}',
    '#pad .u{left:33%;top:0;width:34%;height:33%}',
    '#pad .d{left:33%;bottom:0;width:34%;height:33%}',
    '#pad .l{left:0;top:33%;width:33%;height:34%}',
    '#pad .r{right:0;top:33%;width:33%;height:34%}',
    '#pad .dpad>div.lit{background:rgba(255,255,255,.4)}',
    '#pad .mid{display:flex;justify-content:center;gap:4px}',
    '#pad .hit{width:64px;height:56px;display:flex;align-items:center;justify-content:center}',
    '#pad .pill{width:60px;height:26px;border-radius:13px;display:flex;align-items:center;justify-content:center;',
    'background:rgba(255,255,255,.11);border:1px solid rgba(255,255,255,.22);font-size:9px;pointer-events:none}',
    '#pad .hit.lit .pill{background:rgba(255,255,255,.38)}',
    'body.nofs #pad .h-full{visibility:hidden}',
    '#pad .ab{position:relative;width:156px;height:128px;flex:none}',
    '#pad .btn{position:absolute;width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
    'background:rgba(214,64,52,.26);border:1.5px solid rgba(255,120,100,.46);font-size:18px;letter-spacing:0;box-sizing:border-box}',
    '#pad .btn.b{left:0;bottom:4px}',
    '#pad .btn.a{right:0;top:4px}',
    '#pad .btn.lit{background:rgba(236,72,56,.66)}',
    // landscape (body.land, set by fit()): the pad leaves the page flow for two columns either side of the
    // TV, which fit() shrinks to the space between them, so no control ever lies over the picture. The
    // D-pad sits low in the left column under SELECT and PAUSE; B and A low in the right under START and
    // FULL. fit() writes the sizes and offsets (safe-area insets included) into the variables.
    'body.land:not(.padoff) #pad{position:fixed;inset:0;width:auto;max-width:none;height:auto;min-height:0;padding:0;display:block;pointer-events:none}',
    'body.land #pad .dpad,body.land #pad .ab,body.land #pad .hit{position:fixed;pointer-events:auto}',
    'body.land #pad .mid{display:block}',
    'body.land #pad .dpad{left:var(--lx);bottom:var(--by);width:var(--cd);height:var(--cd)}',
    'body.land #pad .ab{right:var(--rx);bottom:var(--by);width:var(--cd);height:var(--ch)}',
    'body.land #pad .btn{width:var(--cb);height:var(--cb)}',
    'body.land #pad .btn.b{bottom:0}',
    'body.land #pad .btn.a{top:0}',
    'body.land #pad .h-select{left:var(--hlx);top:var(--hy1)}',
    'body.land #pad .h-pause{left:var(--hlx);top:var(--hy2)}',
    'body.land #pad .h-start{right:var(--hrx);top:var(--hy1)}',
    'body.land #pad .h-full{right:var(--hrx);top:var(--hy2)}',
  ].join('');

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const body = document.body;
    const touchParam = params.get('touch');
    S.touchOn = touchParam === '1' || (touchParam !== '0' && !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
    if (S.touchOn) body.classList.add('touch');
    const ui = { nesLit: {}, nesMask: -1, padLit: {}, padMask: -1 };
    const canvas = el('canvas', null, body);
    canvas.id = 'tv';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', CONFIG.title + ' game screen');
    canvas.tabIndex = -1;
    ui.canvas = canvas;
    const chrome = el('div', null, body);
    chrome.id = 'chrome';
    ui.chrome = chrome;
    ui.help = el('div', null, chrome);
    ui.help.id = 'help';
    ui.note = el('div', null, chrome);
    ui.note.id = 'note';
    ui.slot = el('div', null, chrome);
    ui.slot.id = 'slot';
    // the input display
    const nes = el('div', null, ui.slot);
    nes.id = 'nes';
    el('span', 'cap', nes, 'YOU');
    const face = el('div', 'face', el('div', 'shell', nes));
    for (const c of ['v', 'h', 'u', 'd', 'l', 'r', 'mid', 'se', 'st', 'bb', 'ba', 'b', 'a']) {
      const i = el('i', c, face);
      const name = { u: 'UP', d: 'DOWN', l: 'LEFT', r: 'RIGHT', se: 'SELECT', st: 'START', b: 'B', a: 'A' }[c];
      if (name) ui.nesLit[name] = i;
    }
    ui.nes = nes;
    // the live region: polite, at most one announcement a second
    ui.sr = el('div', 'sr', body);
    ui.sr.setAttribute('role', 'status');
    ui.sr.setAttribute('aria-live', 'polite');
    // the probe that reads the safe-area insets
    ui.probe = el('div', null, body);
    ui.probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    S.ui = ui;
    if (S.touchOn) buildPad();
    const fsOk = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    if (!fsOk) body.classList.add('nofs');

    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      toggleFullscreen();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    return ui;
  }

  function light(map, mask, prev) {
    for (const name in map) {
      const on = (mask & BTN[name]) !== 0;
      if (prev < 0 || on !== ((prev & BTN[name]) !== 0)) map[name].classList.toggle('lit', on);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Fit: the TV at 16:9 inside the viewport minus the safe area, the chrome and the touch pad (under the
  // chrome in portrait; in landscape a control column either side)
  // ---------------------------------------------------------------------------------------------
  const HIT_W = 64; // a pill's hit box (#pad .hit)
  const HIT_H = 56;
  function insets() {
    const cs = window.getComputedStyle(S.ui.probe);
    const n = (v) => parseFloat(v) || 0;
    return { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) };
  }
  const landscape = () => window.innerWidth > window.innerHeight;
  function padInFlow() {
    return S.touchOn && !S.padHidden && !landscape();
  }
  // The landscape pad: the D-pad and the B/A cluster are cd wide (cd from the viewport, 112 to 140), the
  // buttons cb (56 to 66), and each column is its control plus a 6 px gutter either side.
  function landPad(w, h) {
    const cd = Math.max(112, Math.min(140, Math.round(Math.min(w * 0.18, h * 0.36))));
    const cb = Math.max(56, Math.min(66, Math.round(cd * 0.48)));
    return { cd, cb, ch: cb + Math.round(cd * 0.4), col: cd + 12 };
  }
  // side: the width of each column beside the TV (inside the safe area). The controls keep to its outer
  // edge; the pills are centred over them.
  function placePad(lp, ins, side) {
    const m = Math.min(24, Math.max(4, Math.floor((side - lp.cd) / 2)));
    const hx = m + lp.cd / 2 - HIT_W / 2;
    const v = { cd: lp.cd, cb: lp.cb, ch: lp.ch, lx: ins.l + m, rx: ins.r + m, by: ins.b + 16,
      hlx: ins.l + hx, hrx: ins.r + hx, hy1: ins.t + 8, hy2: ins.t + 10 + HIT_H };
    const st = document.body.style;
    for (const k in v) st.setProperty('--' + k, v[k] + 'px');
  }
  function fit() {
    if (!S.ui) return false;
    const ins = insets();
    const vw = Math.max(64, window.innerWidth - ins.l - ins.r);
    const vh = Math.max(64, window.innerHeight - ins.t - ins.b);
    const land = S.touchOn && landscape();
    const lp = land ? landPad(window.innerWidth, window.innerHeight) : null;
    const availW = vw - (lp && !S.padHidden ? 2 * lp.col : 0);
    const availH = vh - CHROME_H - (padInFlow() ? PAD_H : 0);
    const cssW = Math.max(160, Math.floor(Math.min(availW, (Math.max(90, availH) * 16) / 9)));
    const cssH = Math.round((cssW * 9) / 16);
    const c = S.ui.canvas;
    c.style.width = cssW + 'px';
    c.style.height = cssH + 'px';
    S.ui.chrome.style.width = cssW + 'px';
    document.body.classList.toggle('land', land);
    if (lp) placePad(lp, ins, (vw - cssW) / 2);
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(2560, cssW * dpr) / 1920;
    if (Math.abs(scale - S.mounted) < 0.001 && FILM.ctx) return false;
    S.mounted = scale;
    FILM.mount(c, { scale });
    S.dirty = true;
    return true;
  }
  function refit() {
    if (fit()) S.dirty = true;
    S.presented = '';
  }

  // ---------------------------------------------------------------------------------------------
  // Sound (U6): the film's driver and chip, live; no AudioContext before the first gesture
  // ---------------------------------------------------------------------------------------------
  function applyVolume() {
    if (!S.gain) return;
    const st = save.settings;
    const v = st.mute ? 0 : Math.pow(st.vol / 10, 2);
    try {
      S.gain.gain.value = v;
    } catch (e) {
      /* a closed context */
    }
  }
  function unlock() {
    if (S.actx) {
      if (S.actx.state === 'suspended' && !document.hidden) S.actx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !FILM.audio || typeof FILM.audio.live !== 'function') return;
    try {
      S.actx = new AC({ latencyHint: 'interactive' });
      S.gain = S.actx.createGain();
      S.gain.connect(S.actx.destination);
      applyVolume();
      S.snd = FILM.audio.live(S.actx, { dest: S.gain, bufferSize: S.touchOn ? 2048 : 1024 });
      // the console asked for its song before there was sound: play it now
      if (S.lastSong) S.snd.event(Object.assign({}, S.lastSong));
      if (S.state === 'paused' && S.lastSong) S.snd.event({ type: 'pause' });
      if (S.actx.state === 'suspended') S.actx.resume().catch(() => {});
      S.actx.onstatechange = () => updateNote();
    } catch (e) {
      S.snd = null;
      if (window.console) console.error(CONFIG.slug + ': audio failed to start', e);
    }
    updateNote();
  }
  const audioState = () => (S.actx ? S.actx.state : 'none');
  // the console's events: remember the song, hand everything to the driver
  function toAudio(ev) {
    if (!ev || !ev.length) return;
    for (const e of ev) if (e.type === 'song') S.lastSong = { type: 'song', id: e.id, section: e.section };
    if (S.snd) S.snd.events(ev);
  }
  function sfx(type) {
    if (type && S.snd) S.snd.event({ type });
  }
  function songNow(id) {
    S.lastSong = { type: 'song', id };
    if (S.snd) S.snd.event({ type: 'song', id });
  }

  // ---------------------------------------------------------------------------------------------
  // Chrome: help, toasts, the sound prompt, announcements
  // ---------------------------------------------------------------------------------------------
  function toast(text) {
    S.toast = { text: String(text), t: TOAST_FRAMES };
    updateNote();
  }
  function updateNote() {
    const ui = S.ui;
    if (!ui) return;
    let text = '';
    let gate = false;
    if (S.toast) text = S.toast.text;
    else if (audioState() !== 'running') {
      text = 'PRESS A KEY OR TAP FOR SOUND';
      gate = true;
    }
    if (ui.note.textContent !== text) ui.note.textContent = text;
    ui.note.classList.toggle('on', !!text);
    ui.note.classList.toggle('gate', gate);
  }
  const lab = (a, i) => MENU.keyLabel(save.settings.keys[a][i || 0]);
  function updateHelp() {
    const ui = S.ui;
    if (!ui || S.touchOn) return;
    const k = save.settings.keys;
    const arrows = k.UP[0] === 'ArrowUp' && k.DOWN[0] === 'ArrowDown' && k.LEFT[0] === 'ArrowLeft' && k.RIGHT[0] === 'ArrowRight';
    const move = arrows ? '←→' : lab('LEFT') + ' ' + lab('RIGHT');
    const mode = S.state === 'game' && S.game ? S.game.mode : '';
    const choose = [arrows ? '↑↓' : lab('UP') + ' ' + lab('DOWN'), 'CHOOSE'];
    let items;
    if (S.state === 'demo') {
      items = [['ANY KEY', 'MENU'], ['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']].concat(LEGAL_ROW);
    } else if (mode === 'gameover' || mode === 'continue') {
      items = [choose, [lab('A') + '/' + lab('START'), 'OK'], ['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']];
    } else if (mode === 'clear') {
      items = [['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']];
    } else if (mode === 'credits') {
      items = [[lab('START'), 'TITLE'], ['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']];
    } else if (S.state === 'game') {
      items = [[move, 'MOVE'], [lab('A'), 'JUMP'], [lab('B'), 'RUN'], [lab('START') + '/P', 'PAUSE'], ['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']];
    } else {
      items = [choose, [lab('A') + '/' + lab('START'), 'OK'], [lab('B'), 'BACK'], ['F', 'FULL'], ['C', 'CRT'], ['M', 'MUTE']].concat(LEGAL_ROW);
    }
    const key = items.map((x) => x.join(' ')).join('|');
    if (ui.helpKey === key) return;
    ui.helpKey = key;
    ui.help.textContent = '';
    for (const [k1, what] of items) {
      const span = el('span', null, ui.help);
      if (k1) el('b', null, span, k1);
      span.appendChild(document.createTextNode(what));
    }
  }
  // screen-reader announcements: at most one a second; a newer menu line replaces an older one
  function say(text, kind) {
    if (!text) return;
    if (kind === 'menu') S.sayQ = S.sayQ.filter((q) => q.kind !== 'menu');
    S.sayQ.push({ text, kind: kind || 'game' });
    if (S.sayQ.length > 4) S.sayQ.shift();
  }
  function flushSay(stamp) {
    if (!S.sayQ.length || stamp - S.sayAt < 1000) return;
    const q = S.sayQ.shift();
    S.ui.sr.textContent = q.text;
    S.sayAt = stamp;
  }
  const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s,'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  function levelName(id) {
    const d = GAME.GAME_DEFS && GAME.GAME_DEFS[id];
    if (d && d.name) return d.name;
    const g = S.game && S.game.snapshot ? S.game.snapshot() : null;
    return g && g.name ? g.name : '';
  }
  const lives = (n) => n + (n === 1 ? ' life' : ' lives');
  function sayMenu() {
    if (!S.menu) return;
    const row = MENU.items(S.menu, menuEnv())[S.menu.sel];
    if (row) say(row.say, 'menu');
  }

  function showInputs() {
    const ui = S.ui;
    if (!ui || !save.settings.input) return;
    if (S.buttons !== ui.nesMask) {
      light(ui.nesLit, S.buttons, ui.nesMask);
      ui.nesMask = S.buttons;
    }
  }
  function applyInputDisplay() {
    if (!S.ui) return;
    S.ui.nes.classList.toggle('on', !!save.settings.input);
    S.ui.nesMask = -1;
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------
  function applyCrt() {
    if (!FILM.crt) return;
    FILM.crt.mode = params.get('clean') === '1' || save.settings.crt === 'off' ? 'clean' : 'crt';
    S.presented = '';
  }
  function rebuildKeys() {
    S.codeBtn = {};
    for (const a of MENU.ACTIONS) for (const c of save.settings.keys[a]) S.codeBtn[c] = BTN[a];
    // held codes that are no longer bound stop counting
    for (const c of Array.from(S.held)) if (!S.codeBtn[c]) S.held.delete(c);
    if (S.ui) S.ui.helpKey = null;
  }
  function setSetting(key, value) {
    save.settings[key] = clone(value);
    if (key === 'crt') applyCrt();
    else if (key === 'vol' || key === 'mute') applyVolume();
    else if (key === 'input') applyInputDisplay();
    else if (key === 'keys') rebuildKeys();
    else if (key === 'flash') S.dirty = true;
    writeSave();
    updateHelp();
  }

  // ---------------------------------------------------------------------------------------------
  // Inputs (U2)
  // ---------------------------------------------------------------------------------------------
  function keysMask() {
    let m = 0;
    for (const c of S.held) m |= S.codeBtn[c] || 0;
    return m;
  }
  function hidePad() {
    if (!S.touchOn || S.padHidden) return;
    S.padHidden = true;
    document.body.classList.add('padoff');
    refit();
  }
  function showPad() {
    if (!S.touchOn || !S.padHidden) return;
    S.padHidden = false;
    document.body.classList.remove('padoff');
    refit();
  }
  const inMenu = () => S.menu && (S.state === 'title' || S.state === 'paused');

  function onKeyDown(e) {
    const code = e.code;
    unlock();
    // CONTROLS waiting for a key: the next key is the binding (Escape cancels)
    if (inMenu() && S.menu.bind) {
      e.preventDefault();
      if (e.repeat) return;
      const r = MENU.key(S.menu, code, menuEnv());
      S.menu = r.state;
      sfx(r.sound);
      if (r.action) menuAction(r.action);
      S.dirty = true;
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts stay the browser's
    hidePad();
    if (MENU.FIXED.indexOf(code) >= 0) {
      e.preventDefault();
      if (e.repeat) return;
      if (code === 'KeyP' || code === 'Escape') pauseKey(code);
      else if (code === 'KeyF') toggleFullscreen();
      else if (code === 'KeyC') {
        setSetting('crt', save.settings.crt === 'off' ? 'on' : 'off');
        toast(save.settings.crt === 'off' ? 'CLEAN' : 'CRT');
      } else if (code === 'KeyM') {
        setSetting('mute', !save.settings.mute);
        toast(save.settings.mute ? 'MUTED' : 'SOUND ON');
      } else if (code === 'KeyI') {
        setSetting('input', !save.settings.input);
        toast(save.settings.input ? 'INPUT DISPLAY ON' : 'INPUT DISPLAY OFF');
      }
      return;
    }
    const b = S.codeBtn[code];
    if (b) {
      e.preventDefault();
      if (e.repeat) return;
      S.held.add(code);
      S.latch |= b;
    }
  }
  function onKeyUp(e) {
    // a release always lands, whatever else is held
    if (S.held.delete(e.code) || S.codeBtn[e.code]) e.preventDefault();
  }

  // P and Escape: pause in play, resume when paused; Escape also backs out of a menu screen
  function pauseKey(code) {
    if (S.state === 'game') requestPause(P_TTL);
    else if (S.state === 'paused') {
      if (code === 'Escape' && S.menu && S.menu.screen !== 'pause') menuPress(BTN.B);
      else S.resumeReq = true;
    } else if (S.state === 'title' && code === 'Escape' && S.menu && S.menu.screen !== 'title') menuPress(BTN.B);
    else if (S.state === 'demo') endDemo();
  }
  // a B (or any) press delivered to the menu at once, outside the step (Escape)
  function menuPress(bits) {
    const r = MENU.step(S.menu, bits, menuEnv());
    handleMenu(r);
  }
  function requestPause(ttl) {
    if (S.state !== 'game' || S.feed) return;
    if (S.pauseReq && S.pauseReq.ttl < 0) return;
    S.pauseReq = { ttl };
  }

  // The standard mapping (w3c): 0 bottom, 1 right, 2 left, 3 top face button, 8 back/select, 9 start,
  // 12-15 the D-pad. The NES has B left of A: the bottom and left buttons are B, the right and top A.
  function pollPads() {
    let list = null;
    try {
      list = navigator.getGamepads ? navigator.getGamepads() : null;
    } catch (e) {
      list = null;
    }
    let m = 0;
    let n = 0;
    if (list) {
      for (const gp of list) {
        if (!gp || gp.connected === false) continue;
        n++;
        const on = (i) => {
          const b = gp.buttons && gp.buttons[i];
          return !!b && (b.pressed || b.value > 0.5);
        };
        if (on(12)) m |= BTN.UP;
        if (on(13)) m |= BTN.DOWN;
        if (on(14)) m |= BTN.LEFT;
        if (on(15)) m |= BTN.RIGHT;
        if (on(1) || on(3)) m |= BTN.A;
        if (on(0) || on(2)) m |= BTN.B;
        if (on(9)) m |= BTN.START;
        if (on(8)) m |= BTN.SELECT;
        const ax = (gp.axes && gp.axes[0]) || 0;
        const ay = (gp.axes && gp.axes[1]) || 0;
        if (ax < -0.5) m |= BTN.LEFT;
        if (ax > 0.5) m |= BTN.RIGHT;
        if (ay < -0.5) m |= BTN.UP;
        if (ay > 0.5) m |= BTN.DOWN;
      }
    }
    if (n > S.pads) padConnected();
    else if (n < S.pads) padLost();
    S.pads = n;
    const pressed = m & ~S.padPrev;
    S.padPrev = m;
    S.pad = m;
    S.latch |= pressed;
    if (pressed) hidePad();
  }
  let padToastAt = -1e9;
  function padConnected() {
    if (S.steps - padToastAt < 30) return;
    padToastAt = S.steps;
    toast('PAD CONNECTED');
  }
  function padLost() {
    toast('PAD DISCONNECTED');
    if (S.state === 'game') requestPause(-1);
  }

  // Touch: every finger is tracked on its own. A finger that lands on the D-pad steers it (8 ways from
  // the pad's centre, a 10% dead radius) wherever it slides; a finger on a button can roll onto the
  // next; a finger within 20 px of the midpoint between B and A presses both.
  function buildPad() {
    const ui = S.ui;
    const pad = el('div', null, document.body);
    pad.id = 'pad';
    pad.setAttribute('data-pad', '');
    const mid = el('div', 'mid', pad);
    const row = el('div', 'row', pad);
    const dpad = el('div', 'dpad', row);
    dpad.setAttribute('data-dpad', '');
    el('div', 'x', dpad);
    for (const [c, name] of [['u', 'UP'], ['d', 'DOWN'], ['l', 'LEFT'], ['r', 'RIGHT']]) ui.padLit[name] = el('div', c, dpad);
    for (const [name, kind] of [['SELECT', 'btn'], ['START', 'btn'], ['PAUSE', 'act'], ['FULL', 'act']]) {
      const h = el('div', 'hit h-' + name.toLowerCase(), mid);
      h.setAttribute(kind === 'btn' ? 'data-btn' : 'data-act', name);
      el('span', 'pill', h, name);
      if (kind === 'btn') ui.padLit[name] = h;
      else ui['act' + name] = h;
    }
    const ab = el('div', 'ab', row);
    for (const name of ['B', 'A']) {
      const b = el('div', 'btn ' + name.toLowerCase(), ab, name);
      b.setAttribute('data-btn', name);
      ui.padLit[name] = b;
      ui['pad' + name] = b;
    }
    ui.pad = pad;
    ui.dpad = dpad;
    bindTouch(pad);
    // a touch anywhere brings a hidden pad back
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') showPad();
    }, true);
  }

  function bindTouch(pad) {
    const fingers = new Map(); // pointerId -> { dpad, mask, act }
    const ui = S.ui;
    function dpadMask(x, y) {
      const r = ui.dpad.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.1) return 0;
      let m = 0;
      const t = 0.4142; // tan 22.5 degrees: eight equal sectors
      if (Math.abs(dx) > Math.abs(dy) * t) m |= dx < 0 ? BTN.LEFT : BTN.RIGHT;
      if (Math.abs(dy) > Math.abs(dx) * t) m |= dy < 0 ? BTN.UP : BTN.DOWN;
      return m;
    }
    const centre = (e) => {
      const r = e.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    function buttonAt(x, y) {
      const [ax, ay] = centre(ui.padA);
      const [bx, by] = centre(ui.padB);
      if (Math.hypot(x - (ax + bx) / 2, y - (ay + by) / 2) <= 20) return BTN.A | BTN.B;
      const hit = document.elementFromPoint(x, y);
      const b = hit && hit.closest ? hit.closest('[data-btn]') : null;
      return b ? BTN[b.getAttribute('data-btn')] || 0 : 0;
    }
    function inAB(x, y) {
      const r = ui.pad.querySelector('.ab').getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function update() {
      let m = 0;
      for (const f of fingers.values()) m |= f.mask;
      const pressed = m & ~S.touch;
      S.touch = m;
      S.latch |= pressed;
      light(ui.padLit, m, ui.padMask);
      ui.padMask = m;
    }
    pad.addEventListener('pointerdown', (e) => {
      const t = e.target;
      const onDpad = !!(t.closest && t.closest('[data-dpad]'));
      const act = t.closest ? t.closest('[data-act]') : null;
      const onBtn = !!(t.closest && t.closest('[data-btn]')) || (!onDpad && !act && inAB(e.clientX, e.clientY));
      if (!onDpad && !onBtn && !act) return;
      e.preventDefault();
      unlock();
      if (act) {
        fingers.set(e.pointerId, { act, mask: 0 });
        act.classList.add('lit');
        return;
      }
      fingers.set(e.pointerId, { dpad: onDpad, mask: onDpad ? dpadMask(e.clientX, e.clientY) : buttonAt(e.clientX, e.clientY) });
      update();
    });
    pad.addEventListener('pointermove', (e) => {
      const f = fingers.get(e.pointerId);
      if (!f || f.act) return;
      e.preventDefault();
      const m = f.dpad ? dpadMask(e.clientX, e.clientY) : buttonAt(e.clientX, e.clientY);
      if (m !== f.mask) {
        f.mask = m;
        update();
      }
    });
    const lift = (e) => {
      const f = fingers.get(e.pointerId);
      if (!f) return;
      fingers.delete(e.pointerId);
      if (f.act) {
        f.act.classList.remove('lit');
        // pointerup is a user gesture: fullscreen may be requested here
        if (e.type === 'pointerup') {
          const what = f.act.getAttribute('data-act');
          if (what === 'FULL') toggleFullscreen();
          else if (what === 'PAUSE') pauseKey('KeyP');
        }
        return;
      }
      update();
    };
    pad.addEventListener('pointerup', lift);
    pad.addEventListener('pointercancel', lift);
    pad.addEventListener('lostpointercapture', lift);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Merge per step (play.js rules): held keys, touch, pad and the latch; minus what was held when a
  // console was taken, until released; opposite directions cancel.
  function readMask() {
    const raw = keysMask() | S.touch | S.pad | S.latch;
    S.latch = 0;
    S.suppress &= raw;
    let m = raw & ~S.suppress;
    if ((m & (BTN.LEFT | BTN.RIGHT)) === (BTN.LEFT | BTN.RIGHT)) m &= ~(BTN.LEFT | BTN.RIGHT);
    if ((m & (BTN.UP | BTN.DOWN)) === (BTN.UP | BTN.DOWN)) m &= ~(BTN.UP | BTN.DOWN);
    return m;
  }
  const rawHeld = () => keysMask() | S.touch | S.pad;

  // ---------------------------------------------------------------------------------------------
  // Consoles and shell states (3.2, 3.3)
  // ---------------------------------------------------------------------------------------------
  const menuEnv = () => ({ save, fromPause: S.state === 'paused', saveOff: !saveOk });

  function newTitle(silent) {
    S.title = FILM.game.create({ shellMenu: true, top: save.hi, feel: save.settings.feel });
    const ev = S.title.step(0);
    if (!silent) toAudio(ev);
  }
  function toTitle(screen) {
    S.state = 'title';
    S.menu = MENU.init(screen || 'title', { save });
    S.waitRelease = true;
    S.dirty = true;
    updateHelp();
    sayMenu();
  }

  function startGame(start, opts) {
    const o = opts || { start, feel: save.settings.feel, top: save.hi, shellMenu: true };
    S.game = FILM.game.create(o);
    S.gameOpts = Object.assign({}, o);
    S.state = 'game';
    S.menu = null;
    S.first = true; // NEW GAME sends START on the console's first step
    S.suppress = rawHeld();
    S.lastSent = 0;
    S.runBest = 0;
    S.pauseReq = null;
    S.resumeReq = false;
    S.rec = PROOF ? { bytes: [], events: [] } : null;
    S.dirty = true;
    updateHelp();
  }

  function startDemo() {
    S.demo = FILM.game.demo();
    S.demoT = 0;
    S.state = 'demo';
    songNow('none');
    S.dirty = true;
    updateHelp();
    say('Demo', 'game');
  }
  function endDemo() {
    S.demo = null;
    songNow('title');
    toTitle('title');
  }

  // the game console's events: sound, the save, announcements
  function gameEvents(ev) {
    toAudio(ev);
    const W = S.game.state();
    if (W.score > S.runBest) S.runBest = W.score;
    for (const e of ev) {
      switch (e.type) {
        case 'levelstart': {
          const L = LEVELS();
          const i = L.indexOf(e.id);
          if (i >= 0 && i > L.indexOf(save.reach)) {
            save.reach = e.id;
            writeSave();
          }
          const name = titleCase(levelName(e.id));
          say('World ' + e.id + (name ? ', ' + name : '') + ', ' + lives(e.lives), 'game');
          break;
        }
        case 'token':
        case 'clear': {
          let changed = false;
          const bits = Object.assign({}, W.tokens || {});
          if (e.type === 'clear' && e.id) bits[e.id] = (bits[e.id] | 0) | (e.tokens | 0);
          for (const id in save.tokens) {
            const v = (save.tokens[id] | (bits[id] | 0)) & 7;
            if (v !== save.tokens[id]) {
              save.tokens[id] = v;
              changed = true;
            }
          }
          if (changed) writeSave();
          if (e.type === 'token') say('Token', 'game');
          else say('World ' + e.id + ' clear', 'game');
          break;
        }
        case 'gameover':
          recordHi();
          say('Game over. Continue or end', 'game');
          break;
        case 'quit':
          recordHi();
          break;
        case 'credits': // the final card: the engine's end-of-game event
        case 'complete':
          S.runBest = Math.max(S.runBest, e.score | 0);
          save.cleared = true;
          recordHi();
          writeSave();
          say('Game complete', 'game');
          break;
        case 'lifelost':
          say(lives(e.lives) + ' left', 'game');
          break;
        case 'checkpoint':
          say('Checkpoint', 'game');
          break;
        case 'hurry':
          say('Hurry', 'game');
          break;
        case 'cursor':
          if (W.cont) say(W.cont.sel ? 'End' : 'Continue', 'menu');
          break;
      }
    }
  }

  // after a game step: the engine paused, or went back to the title by itself (END, the credits)
  function followGame(held) {
    const mode = S.game.mode;
    if (mode === 'pause' && S.state === 'game') {
      S.state = 'paused';
      S.menu = MENU.init('pause', { save, fromPause: true });
      S.pauseReq = null;
      S.suppress = held;
      S.dirty = true;
      say('Paused', 'game');
      updateHelp();
    } else if (mode === 'play' && S.state === 'paused') {
      S.state = 'game';
      S.menu = null;
      S.suppress = held;
      S.dirty = true;
      updateHelp();
    } else if (mode === 'title' && !S.feed) {
      recordHi();
      S.title = S.game; // the shell adopts it as the title console
      S.game = null;
      toTitle('title');
    } else if (S.state === 'game' && mode !== S.helpMode) {
      // game over, continue, the clear card and the credits take other keys than play
      S.helpMode = mode;
      updateHelp();
    }
  }

  function sendGame(b) {
    S.lastSent = b;
    S.buttons = b;
    const ev = S.game.step(b);
    if (S.rec) {
      S.rec.bytes.push(b);
      for (const e of ev) S.rec.events.push(e);
    }
    gameEvents(ev);
    return ev;
  }

  function handleMenu(r) {
    const before = S.menu;
    S.menu = r.state;
    sfx(r.sound);
    if (r.action) menuAction(r.action);
    if (S.menu && (S.menu !== before) && (!before || before.sel !== S.menu.sel || before.screen !== S.menu.screen)) sayMenu();
    S.dirty = true;
  }

  function menuAction(a) {
    switch (a.type) {
      case 'new':
        startGame(CONFIG.firstLevel);
        break;
      case 'continue':
        startGame(a.level);
        break;
      case 'demo':
        startDemo();
        break;
      case 'resume':
        S.resumeReq = true;
        break;
      case 'quit':
        recordHi();
        S.game = null;
        newTitle(false);
        toTitle('title');
        break;
      case 'set':
        setSetting(a.key, a.value);
        if (a.key !== 'keys') sayMenu();
        else say('Controls saved', 'menu');
        break;
      case 'bind':
        say('Press a key for ' + a.action, 'menu');
        break;
      case 'erase': {
        const keep = save.settings;
        save = defaults();
        save.settings = keep; // ERASE SAVE clears progress; the settings are the player's
        writeSave();
        newTitle(true); // the title's HI-SCORE starts again from 0
        say('Save erased', 'menu');
        break;
      }
    }
  }

  // one 60 Hz step of whatever the shell is showing
  function stepOnce() {
    S.steps++;
    if (S.toast && --S.toast.t <= 0) {
      S.toast = null;
      updateNote();
    }
    if (S.feed) return feedStep();
    const m = readMask();
    let edges = m & ~S.prevMask;
    S.prevMask = m;
    switch (S.state) {
      case 'title': {
        toAudio(S.title.step(0));
        if (S.waitRelease) {
          if (m === 0) S.waitRelease = false;
          edges = 0;
        }
        S.buttons = m;
        handleMenu(MENU.step(S.menu, edges, menuEnv()));
        break;
      }
      case 'demo': {
        S.buttons = 0;
        S.demoT++;
        if (edges) {
          endDemo(); // the press is consumed: the menu waits for every button to be released
          break;
        }
        S.demo.step(); // the demo's events never reach the audio
        if (S.demo.done) endDemo();
        break;
      }
      case 'game': {
        let b = m;
        if (S.first) {
          b = BTN.START;
          S.first = false;
        } else if (S.pauseReq) {
          if (S.game.pausable) {
            if (S.lastSent & BTN.START) b = m & ~BTN.START; // one frame without START, so the press is an edge
            else {
              b = m | BTN.START;
              S.pauseReq = null;
            }
          } else if (S.pauseReq.ttl > 0 && --S.pauseReq.ttl === 0) S.pauseReq = null;
        }
        sendGame(b);
        followGame(rawHeld());
        break;
      }
      case 'paused': {
        let b = 0;
        if (!S.resumeReq) {
          handleMenu(MENU.step(S.menu, edges, menuEnv()));
          S.buttons = m;
        }
        if (S.state !== 'paused') break; // QUIT went to the title
        if (S.resumeReq) {
          S.resumeReq = false;
          b = BTN.START;
        }
        sendGame(b);
        if (b) S.buttons = b;
        followGame(rawHeld());
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Drawing and presenting
  // ---------------------------------------------------------------------------------------------
  function paint() {
    const nb = FILM.native();
    const g = nb.ctx;
    const view = { reducedFlash: save.settings.flash === 'reduced' };
    switch (S.state) {
      case 'boot':
      case 'title': {
        S.title.draw(g, view);
        MENU.draw(g, S.menu, { top: S.title.state().top }, save, { saveOff: !saveOk });
        break;
      }
      case 'demo':
        S.demo.draw(g, view);
        demoPlate(g, S.demoT);
        MENU.drawDemo(g, S.demoT);
        break;
      case 'game':
        S.game.draw(g, view);
        break;
      case 'paused': {
        S.game.draw(g, view);
        const s = S.game.snapshot();
        MENU.draw(g, S.menu, { name: s.name, tokens: s.tokens, world: s.world, top: s.top }, save, { saveOff: !saveOk });
        break;
      }
    }
    return nb;
  }
  // The DEMO label (11.6: centred at y 40, 32 frames on, 32 off) gets a solid $0F plate under it while it
  // shows, so it reads on the sky, the blue ceiling bricks and black alike: 4 px either side of the ink and
  // its shadow, 3 px above and below.
  function demoPlate(g, t) {
    if ((t | 0) % 64 >= 32) return;
    const L = FILM.retro;
    const tw = L.pxtextWidth('DEMO');
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = L.NES[0x0f];
    g.fillRect(160 - Math.floor(tw / 2) - 4, 37, tw + 9, 14);
    g.restore();
  }
  let presentErr = false;
  function present(nb, clean) {
    if (!FILM.ctx) return;
    const crt = FILM.crt;
    if (clean || !crt || typeof crt.present !== 'function' || crt.mode === 'clean') {
      FILM.presentNearest(nb.canvas, FILM.ctx);
      return;
    }
    try {
      crt.present(nb.canvas, FILM.ctx, { frame: crt.settledFrame(), overlays: false });
    } catch (e) {
      if (!presentErr && window.console) console.error(CONFIG.slug + ': the CRT failed, presenting clean', e);
      presentErr = true;
      crt.mode = 'clean';
      FILM.presentNearest(nb.canvas, FILM.ctx);
    }
  }
  function outKey() {
    const out = FILM.ctx && FILM.ctx.canvas;
    const crt = FILM.crt;
    return out ? out.width + 'x' + out.height + ':' + (crt ? crt.mode + (crt.lost ? '!' : '') + (crt.backend || '') : '') : '';
  }

  // The title builds every sprite variant ahead of play (GAME.warmStep, 11.1 step 5): 24 names an animation
  // frame. A frame that overran (its stamp came more than three console frames after the last) halves the
  // batch, down to one name, so a slow phone keeps a smooth title while it warms; quick frames grow it back.
  const WARM_MAX = 24;
  function warm(stamp) {
    const gap = S.lastStamp == null ? 0 : stamp - S.lastStamp;
    S.lastStamp = stamp;
    if (S.warmed || S.state !== 'title' || typeof GAME.warmStep !== 'function') return;
    if (gap > 3 * GAME.clock.STEP_MS) S.warmN = Math.max(1, S.warmN >> 1);
    else if (gap > 0 && gap < 1.5 * GAME.clock.STEP_MS && S.warmN < WARM_MAX) S.warmN++;
    S.warmed = GAME.warmStep(S.warmN) === true;
  }

  function frame(stamp) {
    window.requestAnimationFrame(frame);
    S.rafs++;
    pollPads();
    warm(stamp);
    const n = S.fast > 0 ? S.fast : GAME.clock.advance(S.clock, stamp);
    for (let i = 0; i < n; i++) stepOnce();
    const key = outKey();
    if (n > 0 || S.dirty || key !== S.presented) {
      present(paint());
      S.presented = outKey();
      S.dirty = false;
    }
    if (S.rateT0 == null) {
      S.rateT0 = stamp;
      S.rateN0 = S.steps;
    } else if (stamp - S.rateT0 >= 1000) {
      S.rate = ((S.steps - S.rateN0) * 1000) / (stamp - S.rateT0);
      S.rateT0 = stamp;
      S.rateN0 = S.steps;
    }
    showInputs();
    flushSay(stamp);
  }

  // ---------------------------------------------------------------------------------------------
  // Pause, visibility, focus (U7), fullscreen (U8)
  // ---------------------------------------------------------------------------------------------
  function onHidden() {
    if (S.state === 'game') {
      requestPause(-1);
      // apply it now when the frame allows (a hidden tab may get no animation frames)
      for (let i = 0; i < 2 && S.state === 'game' && S.pauseReq && S.game.pausable; i++) stepOnce();
      if (S.state === 'paused') present(paint());
    }
    if (S.actx && S.actx.state === 'running') S.actx.suspend().catch(() => {});
  }
  function onVisible() {
    GAME.clock.reset(S.clock); // no catch-up for the time away
    if (S.actx && S.actx.state === 'suspended') S.actx.resume().catch(() => {});
    S.presented = '';
  }
  function toggleFullscreen() {
    const d = document;
    const root = d.documentElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else if (root.requestFullscreen) {
        const p = root.requestFullscreen({ navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => {});
      } else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    } catch (e) {
      /* not allowed here */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Proof hooks (?proof=1): they only feed controller bytes, so they do nothing a player cannot
  // ---------------------------------------------------------------------------------------------
  function fingerprint(events, score) {
    let h = 0x811c9dc5 | 0;
    const mix = (str) => {
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    };
    for (const e of events) mix(e.f + e.type + ';');
    mix('score' + score);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function decode(rle) {
    const out = [];
    for (const run of String(rle || '').split(',')) {
      if (!run) continue;
      const [b, n] = run.split(':');
      const v = parseInt(b, 16) & 255;
      for (let k = parseInt(n, 36); k > 0; k--) out.push(v);
    }
    return out;
  }
  function encode(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; ) {
      let j = i;
      while (j < bytes.length && bytes[j] === bytes[i]) j++;
      out.push(bytes[i].toString(16).padStart(2, '0') + ':' + (j - i).toString(36));
      i = j;
    }
    return out.join(',');
  }
  function feedStep() {
    const f = S.feed;
    if (!S.game || f.i >= f.tape.length) return finishFeed();
    const b = f.tape[f.i++];
    S.prevMask = 0;
    const ev = sendGame(b);
    for (const e of ev) f.events.push(e);
    // draw what the engine shows; inputs stay the tape's until it ends
    const mode = S.game.mode;
    if (mode === 'pause' && S.state === 'game') {
      S.state = 'paused';
      S.menu = MENU.init('pause', { save, fromPause: true });
    } else if (mode !== 'pause' && S.state === 'paused') {
      S.state = 'game';
      S.menu = null;
    }
    if (f.i >= f.tape.length) finishFeed();
  }
  function finishFeed() {
    const f = S.feed;
    S.feed = null;
    const score = S.game ? S.game.state().score : 0;
    const fp = fingerprint(f.events, score);
    const types = {}; // how many of each event the tape produced (a quick read of what it did)
    for (const e of f.events) types[e.type] = (types[e.type] | 0) + 1;
    f.result = { fp, frames: f.i, score, want: f.want, match: f.want ? fp === f.want : null, mode: S.game ? S.game.mode : 'none', types };
    S.suppress = rawHeld();
    S.latch = 0;
    if (S.game) followGame(rawHeld());
    f.resolve(f.result);
  }
  function feed(tape) {
    if (!tape || typeof tape.rle !== 'string') return Promise.reject(new Error('feed: a tape { opts, rle, frames, fp }'));
    const bytes = decode(tape.rle);
    const opts = Object.assign({ start: CONFIG.firstLevel, feel: save.settings.feel, top: save.hi, shellMenu: true }, tape.opts || {});
    startGame(opts.start, opts);
    S.first = false; // the tape carries its own START press
    S.demo = null;
    return new Promise((resolve) => {
      S.feed = { tape: bytes, i: 0, events: [], want: tape.fp || null, resolve, result: null };
    });
  }

  function snapNow() {
    const c = S.state === 'game' || S.state === 'paused' ? S.game : S.state === 'demo' ? null : S.title;
    if (!c) {
      const s = S.demo ? S.demo.snapshot() : null;
      return s ? { m: s.m, lid: s.lid, x: null, y: null, st: null, score: s.score, lives: s.lives, tokens: s.tokenTotal | 0, top: s.top } : null;
    }
    const W = c.state();
    const s = c.snapshot();
    const p = W.p || {};
    return { m: s.m, lid: s.lid, x: p.x, y: p.y, st: p.st, score: W.score, lives: W.lives, tokens: s.tokenTotal | 0, top: W.top };
  }

  const stats = Object.freeze({
    get state() {
      if (S.state === 'title' && S.menu) {
        const sc = S.menu.screen;
        return sc === 'controls' ? 'controls' : sc === 'options' || sc === 'erase' ? 'options' : 'title';
      }
      return S.state;
    },
    get mode() {
      const c = S.state === 'game' || S.state === 'paused' ? S.game : S.state === 'demo' ? null : S.title;
      return c ? c.mode : S.state === 'demo' ? 'demo' : 'none';
    },
    get levelId() {
      const c = S.state === 'game' || S.state === 'paused' ? S.game : null;
      if (!c) return '';
      const W = c.state();
      return W.lv && W.lv.def ? String(W.lv.def.id) : '';
    },
    get steps() {
      return S.steps;
    },
    get rafs() {
      return S.rafs;
    },
    get rate() {
      return S.rate;
    },
    get backend() {
      const crt = FILM.crt;
      if (!crt || crt.mode === 'clean' || crt.lost) return 'clean';
      return crt.backend || 'none';
    },
    get audio() {
      return audioState();
    },
    get save() {
      return saveOk ? 'ok' : 'off';
    },
    get buttons() {
      return S.buttons;
    },
    get frame() {
      const c = S.state === 'game' || S.state === 'paused' ? S.game : S.state === 'demo' ? S.demo : S.title;
      return c ? c.frame : 0;
    },
  });

  const shell = { stats };
  if (PROOF) {
    shell.proof = Object.freeze({
      feed,
      fast(n) {
        S.fast = Math.max(0, Math.min(16, Math.floor(Number(n) || 0)));
        if (!S.fast) GAME.clock.reset(S.clock);
        return S.fast;
      },
      idle(frames) {
        if (S.state !== 'title' || !S.menu || S.menu.screen !== 'title') return false;
        S.menu = Object.assign({}, S.menu, { idle: S.menu.idle + Math.max(0, Math.floor(Number(frames) || 0)) });
        return true;
      },
      snap: snapNow,
      pixels() {
        const nb = FILM.native();
        return Array.from(nb.ctx.getImageData(0, 0, nb.w, nb.h).data);
      },
      // the current game console's tape since it was created: { opts, rle, frames, fp }
      record() {
        if (!S.rec || !S.game) return null;
        return { opts: Object.assign({}, S.gameOpts), rle: encode(S.rec.bytes), frames: S.rec.bytes.length, fp: fingerprint(S.rec.events, S.game.state().score) };
      },
      get feeding() {
        return !!S.feed;
      },
    });
  }
  FILM.shell = Object.freeze(shell);

  // ---------------------------------------------------------------------------------------------
  // Boot (11.1)
  // ---------------------------------------------------------------------------------------------
  function boot() {
    loadSave(); // 1
    if (FILM.crt) FILM.crt.recover = true;
    buildUI();
    applyCrt();
    rebuildKeys();
    applyInputDisplay();
    fit(); // 2
    newTitle(false); // 3: the title console, stepped once with 0
    S.menu = MENU.init('title', { save });
    S.state = 'title';
    present(paint(), true); // a clean first paint; the CRT shader compiles on the next frame (4)
    S.presented = '';
    updateHelp();
    updateNote();
    sayMenu();

    for (const type of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(type, unlock, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => {
      S.held.clear();
      S.latch = 0;
      if (S.state === 'game') requestPause(-1);
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? onHidden() : onVisible()));
    window.addEventListener('pagehide', recordHi);
    window.addEventListener('gamepadconnected', () => padConnected());
    window.addEventListener('gamepaddisconnected', () => {
      pollPads();
      if (S.state === 'game') requestPause(-1);
    });
    for (const type of ['resize', 'orientationchange', 'fullscreenchange', 'webkitfullscreenchange']) window.addEventListener(type, refit);
    document.addEventListener('fullscreenchange', refit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
