// game/50-menu.js : the game page's menus (docs/game-spec.md 11.4 and 11.5). Owner: P6.
//
// Pure state machines and their painters. No DOM, no storage, no clocks: the shell (src/shell.js) owns
// every side effect and feeds the menus one 60 Hz step at a time.
//
//   GAME.menu.init(screen, env)               -> state            screen: 'title' | 'pause' (or any screen)
//   GAME.menu.step(state, pressed, env)       -> { state, action, sound }
//   GAME.menu.key(state, code, env)           -> { state, action, sound }   a raw key while binding (CONTROLS)
//   GAME.menu.draw(g, state, snap, save, x)   paints into the 320x180 native buffer, NES colours only
//   GAME.menu.drawDemo(g, t)                  the attract demo's blinking DEMO
//   GAME.menu.items(state, env)               the screen's rows (for the shell's announcements and tests)
//   GAME.menu.rebind(keys, action, slot, code) -> keys | null     swap-on-rebind; null when the code is refused
//   GAME.menu.keyLabel(code), GAME.menu.bindable(code), GAME.menu.DEFAULT_KEYS, GAME.menu.ACTIONS, GAME.menu.IDLE
//
// pressed: the button edges of this step (FILM.game.BUTTONS bits). env: { save, fromPause, saveOff }.
// UP and DOWN move (SELECT cycles down), LEFT and RIGHT change a value (or pick a key slot), A or START
// confirms, B backs out. Every move sounds 'cursor', every confirm 'select', every back 'back' (the shell
// sends the sound straight to the audio queue). Disabled rows are skipped. Menus have no time limits;
// only the title counts idle steps (1080 without a button edge gives { type: 'demo' }) and a key binding
// gives up after 300 steps.
//
// Actions: { type: 'new' }, { type: 'continue', level }, { type: 'resume' }, { type: 'quit' },
// { type: 'set', key, value } (key is a save.settings field), { type: 'bind', action, slot }, { type: 'erase' },
// { type: 'demo' }.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});

  const B = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  const IDLE = 1080; // ATTRACT_IDLE: 18 s on the title without a button edge starts the demo
  const REMAP_TIMEOUT = 300; // a binding waits this many steps for a key
  const NOTE_FRAMES = 90; // a refusal note under the CONTROLS list

  const ACTIONS = Object.freeze(['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT']);
  const DEFAULT_KEYS = Object.freeze({
    UP: Object.freeze(['ArrowUp', 'KeyW']),
    DOWN: Object.freeze(['ArrowDown', 'KeyS']),
    LEFT: Object.freeze(['ArrowLeft', 'KeyA']),
    RIGHT: Object.freeze(['ArrowRight', 'KeyD']),
    A: Object.freeze(['KeyZ', 'KeyK']),
    B: Object.freeze(['KeyX', 'KeyJ']),
    START: Object.freeze(['Enter', 'NumpadEnter']),
    SELECT: Object.freeze(['ShiftLeft', 'ShiftRight']),
  });
  // the page's own keys, never bindable: P and Escape pause, F fullscreen, C the TV, M mute, I input display
  const FIXED = new Set(['KeyP', 'Escape', 'KeyF', 'KeyC', 'KeyM', 'KeyI']);
  // modifier-only keys belong to the browser's shortcuts (Shift is a console button: SELECT's default)
  const MODIFIER = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'ContextMenu', 'NumLock', 'ScrollLock']);

  function bindable(code) {
    return typeof code === 'string' && code.length > 0 && code !== 'Unidentified' && !FIXED.has(code) && !MODIFIER.has(code);
  }

  const LABELS = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Space: 'SPACE', Enter: 'ENTER',
    NumpadEnter: 'NENTER', ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT' };
  // a key's label on the CONTROLS screen: A-Z and 0-9 only (every glyph is in lib.FONT), at most 6
  function keyLabel(code) {
    if (!code) return '-';
    if (LABELS[code]) return LABELS[code];
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return 'NUM' + m[1];
    const s = String(code).replace(/^(Key|Digit)/, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return s || '?';
  }

  const copyKeys = (keys) => {
    const out = {};
    for (const a of ACTIONS) out[a] = [keys[a][0], keys[a][1]];
    return out;
  };
  // Bind `code` to keys[action][slot]. A code already bound anywhere else takes the replaced code in its
  // place (a swap), so no key is ever bound twice. Refused (null): a fixed key or a modifier-only key.
  function rebind(keys, action, slot, code) {
    if (!bindable(code) || ACTIONS.indexOf(action) < 0 || (slot !== 0 && slot !== 1)) return null;
    const out = copyKeys(keys);
    const old = out[action][slot];
    if (old === code) return out;
    for (const a of ACTIONS) for (let s = 0; s < 2; s++) if (out[a][s] === code) out[a][s] = old;
    out[action][slot] = code;
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Screens and rows
  // ------------------------------------------------------------------------------------------
  const settings = (env) => (env && env.save && env.save.settings) || {};
  const firstLevel = () => (GAME.CONFIG && GAME.CONFIG.firstLevel) || ((GAME.CONFIG && GAME.CONFIG.order) || [])[0] || (GAME.GAME_ORDER || [])[0];
  const reachOf = (env) => (env && env.save && typeof env.save.reach === 'string' ? env.save.reach : firstLevel());

  const FEEL = { modern: 'MODERN', nes: 'NES ACCURATE' };
  const ROWS = {
    feel: { label: 'FEEL', key: 'feel', values: ['modern', 'nes'], show: (v) => FEEL[v] || 'MODERN', say: (v) => (v === 'nes' ? 'NES accurate' : 'modern') },
    crt: { label: 'DISPLAY', key: 'crt', values: ['on', 'off'], show: (v) => (v === 'off' ? 'CLEAN' : 'CRT'), say: (v) => (v === 'off' ? 'clean' : 'CRT') },
    vol: { label: 'VOLUME', key: 'vol', range: [0, 10], show: (v) => '< ' + v + ' >', say: (v) => String(v) },
    input: { label: 'INPUT DISPLAY', key: 'input', values: [false, true], show: (v) => (v ? 'ON' : 'OFF'), say: (v) => (v ? 'on' : 'off') },
    flash: { label: 'FLASHING', key: 'flash', values: ['full', 'reduced'], show: (v) => (v === 'reduced' ? 'REDUCED' : 'FULL'), say: (v) => (v === 'reduced' ? 'reduced' : 'full') },
    controls: { label: 'CONTROLS', go: 'controls' },
    erase: { label: 'ERASE SAVE', go: 'erase' },
    back: { label: 'BACK', back: true },
  };
  const OPTIONS_TITLE = ['feel', 'crt', 'vol', 'input', 'flash', 'controls', 'erase', 'back'];
  const OPTIONS_PAUSE = ['crt', 'vol', 'input', 'flash', 'controls', 'back'];
  const CONTROL_ROWS = ACTIONS.concat(['reset', 'back']);
  const ACTION_LABEL = { UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT', A: 'A (JUMP)', B: 'B (RUN/THROW)', START: 'START', SELECT: 'SELECT' };

  // the rows of a screen: { id, label, disabled, value?, say }
  function items(state, env) {
    const st = settings(env);
    switch (state.screen) {
      case 'title': {
        const reach = reachOf(env);
        const off = reach === firstLevel();
        return [
          { id: 'new', label: 'NEW GAME', say: 'New game' },
          { id: 'continue', label: off ? 'CONTINUE' : 'CONTINUE ' + reach, disabled: off, say: 'Continue, world ' + reach },
          { id: 'options', label: 'OPTIONS', say: 'Options' },
        ];
      }
      case 'options':
        return (state.from === 'pause' ? OPTIONS_PAUSE : OPTIONS_TITLE).map((id) => {
          const r = ROWS[id];
          const it = { id, label: r.label, say: r.label.charAt(0) + r.label.slice(1).toLowerCase() };
          if (r.key) {
            it.value = st[r.key];
            it.say += ', ' + r.say(st[r.key]);
          }
          return it;
        });
      case 'controls':
        return CONTROL_ROWS.map((id) => {
          if (id === 'reset') return { id, label: 'RESET DEFAULTS', say: 'Reset defaults' };
          if (id === 'back') return { id, label: 'BACK', say: 'Back' };
          const keys = (st.keys && st.keys[id]) || DEFAULT_KEYS[id];
          return { id, label: ACTION_LABEL[id], keys, say: ACTION_LABEL[id].replace(/[()]/g, '').toLowerCase() + ', ' + keyLabel(keys[0]) + ' or ' + keyLabel(keys[1]) };
        });
      case 'erase':
        return [{ id: 'no', label: 'NO', say: 'No' }, { id: 'yes', label: 'YES', say: 'Yes, erase' }];
      case 'pause':
        return [{ id: 'resume', label: 'RESUME', say: 'Resume' }, { id: 'options', label: 'OPTIONS', say: 'Options' }, { id: 'quit', label: 'QUIT', say: 'Quit' }];
      case 'quit':
        return [{ id: 'no', label: 'NO', say: 'No' }, { id: 'yes', label: 'YES', say: 'Yes, quit' }];
    }
    return [];
  }

  function firstEnabled(list, from) {
    for (let i = 0; i < list.length; i++) {
      const k = (from + i) % list.length;
      if (!list[k].disabled) return k;
    }
    return 0;
  }
  // a new state on `screen` with the cursor on row `sel` (moved on past a disabled row)
  function on(screen, sel, extra, env) {
    const s = Object.assign({ screen, sel: 0, idle: 0, from: 'title', slot: 0, bind: null, note: null }, extra || {});
    s.screen = screen;
    const list = items(s, env);
    s.sel = firstEnabled(list, Math.max(0, Math.min(list.length - 1, sel | 0)));
    return s;
  }

  function init(screen, env) {
    if (screen === 'options' || screen === 'controls') return on(screen, 0, { from: env && env.fromPause ? 'pause' : 'title' }, env);
    return on(screen || 'title', 0, { from: screen === 'pause' || screen === 'quit' || (env && env.fromPause) ? 'pause' : 'title' }, env);
  }

  // move the cursor by d rows, skipping disabled rows, wrapping
  function move(list, sel, d) {
    const n = list.length;
    for (let i = 1; i <= n; i++) {
      const k = (((sel + d * i) % n) + n) % n;
      if (!list[k].disabled) return k;
    }
    return sel;
  }

  // a settings row's next value (dir -1 or +1), or undefined when it cannot move
  function nextValue(row, cur, dir) {
    if (row.range) {
      const v = Math.max(row.range[0], Math.min(row.range[1], (Number(cur) | 0) + dir));
      return v === cur ? undefined : v;
    }
    const i = Math.max(0, row.values.indexOf(cur));
    return row.values[(i + (dir > 0 ? 1 : row.values.length - 1)) % row.values.length];
  }

  const R = (state, action, sound) => ({ state, action: action || null, sound: sound || null });

  function step(state, pressed, env) {
    pressed = pressed | 0;
    let s = Object.assign({}, state);
    if (s.note) s.note = s.note.t > 1 ? { text: s.note.text, t: s.note.t - 1 } : null;
    const list = items(s, env);

    // CONTROLS while binding: only time passes here (the key arrives through key()); a pad's B cancels
    if (s.bind) {
      if (pressed & B.B) return R(Object.assign(s, { bind: null }), null, 'back');
      const t = s.bind.t + 1;
      if (t >= REMAP_TIMEOUT) return R(Object.assign(s, { bind: null, note: { text: 'NO KEY PRESSED', t: NOTE_FRAMES } }), null, 'back');
      s.bind = { action: s.bind.action, slot: s.bind.slot, t };
      return R(s);
    }

    if (s.screen === 'title') {
      if (pressed) s.idle = 0;
      else if (++s.idle >= IDLE) {
        s.idle = 0;
        return R(s, { type: 'demo' });
      }
    }

    // the pause screen: START resumes whatever the cursor is on
    if (s.screen === 'pause' && pressed & B.START) return R(s, { type: 'resume' }, 'select');

    if (pressed & (B.UP | B.DOWN | B.SELECT)) {
      const d = pressed & B.UP && !(pressed & (B.DOWN | B.SELECT)) ? -1 : 1;
      const k = move(list, s.sel, d);
      if (k === s.sel) return R(s);
      s.sel = k;
      if (s.screen === 'controls') s.slot = Math.min(s.slot, 1);
      return R(s, null, 'cursor');
    }

    const row = list[s.sel] || {};
    if (pressed & (B.LEFT | B.RIGHT)) {
      const dir = pressed & B.LEFT ? -1 : 1;
      if (s.screen === 'options' && ROWS[row.id] && ROWS[row.id].key) {
        const r = ROWS[row.id];
        const v = nextValue(r, settings(env)[r.key], dir);
        if (v === undefined) return R(s);
        return R(s, { type: 'set', key: r.key, value: v }, 'cursor');
      }
      if (s.screen === 'controls' && ACTIONS.indexOf(row.id) >= 0) {
        const slot = dir < 0 ? 0 : 1;
        if (slot === s.slot) return R(s);
        s.slot = slot;
        return R(s, null, 'cursor');
      }
      if (s.screen === 'erase' || s.screen === 'quit') {
        s.sel = s.sel ? 0 : 1;
        return R(s, null, 'cursor');
      }
      return R(s);
    }

    if (pressed & B.B) return back(s, env);

    if (pressed & (B.A | B.START)) {
      if (row.disabled) return R(s);
      switch (s.screen) {
        case 'title':
          if (row.id === 'new') return R(s, { type: 'new' }, 'select');
          if (row.id === 'continue') return R(s, { type: 'continue', level: reachOf(env) }, 'select');
          if (row.id === 'options') return R(on('options', 0, { from: 'title' }, env), null, 'select');
          break;
        case 'options': {
          const r = ROWS[row.id];
          if (r.key) {
            const cur = settings(env)[r.key];
            // A on a value steps it forward; VOLUME wraps to 0 after 10
            const v = r.range ? ((Number(cur) | 0) >= r.range[1] ? r.range[0] : (Number(cur) | 0) + 1) : nextValue(r, cur, 1);
            return R(s, { type: 'set', key: r.key, value: v }, 'select');
          }
          if (r.go === 'controls') return R(on('controls', 0, { from: s.from }, env), null, 'select');
          if (r.go === 'erase') return R(on('erase', 0, { from: s.from }, env), null, 'select');
          if (r.back) return back(s, env);
          break;
        }
        case 'controls':
          if (row.id === 'reset') return R(s, { type: 'set', key: 'keys', value: copyKeys(DEFAULT_KEYS) }, 'select');
          if (row.id === 'back') return back(s, env);
          s.bind = { action: row.id, slot: s.slot, t: 0 };
          s.note = null;
          return R(s, { type: 'bind', action: row.id, slot: s.slot }, 'select');
        case 'erase':
          if (row.id === 'yes') return R(on('options', OPTIONS_TITLE.indexOf('erase'), { from: s.from }, env), { type: 'erase' }, 'select');
          return back(s, env);
        case 'pause':
          if (row.id === 'resume') return R(s, { type: 'resume' }, 'select');
          if (row.id === 'options') return R(on('options', 0, { from: 'pause' }, env), null, 'select');
          if (row.id === 'quit') return R(on('quit', 0, { from: 'pause' }, env), null, 'select');
          break;
        case 'quit':
          if (row.id === 'yes') return R(s, { type: 'quit' }, 'select');
          return back(s, env);
      }
    }
    return R(s);
  }

  // B (or BACK): up one screen; the pause screen's B resumes
  function back(s, env) {
    switch (s.screen) {
      case 'options':
        return s.from === 'pause'
          ? R(on('pause', 1, { from: 'pause' }, env), null, 'back')
          : R(on('title', 2, { from: 'title' }, env), null, 'back');
      case 'controls':
        return R(on('options', (s.from === 'pause' ? OPTIONS_PAUSE : OPTIONS_TITLE).indexOf('controls'), { from: s.from }, env), null, 'back');
      case 'erase':
        return R(on('options', OPTIONS_TITLE.indexOf('erase'), { from: s.from }, env), null, 'back');
      case 'quit':
        return R(on('pause', 2, { from: 'pause' }, env), null, 'back');
      case 'pause':
        return R(s, { type: 'resume' }, 'back');
    }
    return R(s);
  }

  // A raw key while binding: Escape cancels, a fixed or modifier key is refused (the binding waits on),
  // anything else is bound with swap-on-rebind and saved through { type: 'set', key: 'keys' }.
  function key(state, code, env) {
    const s = Object.assign({}, state);
    if (!s.bind) return R(s);
    if (code === 'Escape') return R(Object.assign(s, { bind: null }), null, 'back');
    const cur = (settings(env).keys) || DEFAULT_KEYS;
    const keys = rebind(cur, s.bind.action, s.bind.slot, code);
    if (!keys) {
      const text = FIXED.has(code) ? keyLabel(code) + ' IS RESERVED' : 'USE ANOTHER KEY';
      return R(Object.assign(s, { note: { text, t: NOTE_FRAMES } }), null, 'back');
    }
    return R(Object.assign(s, { bind: null, note: null }), { type: 'set', key: 'keys', value: keys }, 'select');
  }

  // ------------------------------------------------------------------------------------------
  // Painters (native buffer, NES colours only, cached per content through GAME.layer)
  // ------------------------------------------------------------------------------------------
  let L = null;
  let N = null;
  function libs() {
    if (!L) {
      L = FILM.retro;
      N = L.NES;
    }
  }
  const pad6 = (n) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(6, '0');
  // the font has no brackets on older libs: 'A (JUMP)' reads 'A - JUMP' there
  const txt = (s) => (L.FONT['('] && L.FONT[')'] ? s : s.replace(/ \(([^)]*)\)/, ' - $1'));

  function panel(g, x0, y0, x1, y1) {
    g.fillStyle = N[0x26];
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = N[0x0f];
    g.fillRect(x0 + 2, y0 + 2, x1 - x0 - 4, y1 - y0 - 4);
  }
  function tokenRow(g, bits, y) {
    for (let i = 0; i < 3; i++) L.pxtext(g, '✻', 160 - 20 + 16 * i, y, { color: (bits >> i) & 1 ? N[0x26] : N[0x00] });
  }

  function drawTitle(g, state, snap, save) {
    const env = { save };
    const list = items(state, env);
    const hi = Math.max(Number(save && save.hi) || 0, Number(snap && snap.top) || 0);
    const key = 'title|' + state.sel + '|' + list[1].label + '|' + (list[1].disabled ? 1 : 0) + '|' + hi;
    GAME.layer(g, 'm-title', key, 180, (c) => {
      const Y = [94, 106, 118];
      for (let i = 0; i < list.length; i++) {
        L.pxtext(c, list[i].label, 124, Y[i], { color: list[i].disabled ? N[0x00] : N[0x30], shadow: N[0x0f] });
      }
      L.pxtext(c, '▶', 110, Y[state.sel] || 94, { color: N[0x26], shadow: N[0x0f] });
      // the hi-score sits on 1-1's light green bush: a full $0F outline, not only the drop shadow
      const hs = 'HI-SCORE ' + pad6(hi);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) L.pxtext(c, hs, 160 + dx, 136 + dy, { color: N[0x0f], align: 'center' });
      L.pxtext(c, hs, 160, 136, { color: N[0x30], align: 'center', shadow: N[0x0f] });
    });
  }

  function drawOptions(g, state, save, x) {
    const env = { save };
    const list = items(state, env);
    const off = !!(x && x.saveOff);
    const key = 'options|' + state.from + '|' + state.sel + '|' + list.map((r) => String(r.value)).join(',') + '|' + off;
    GAME.layer(g, 'm-options', key, 180, (c) => {
      c.fillStyle = N[0x0f];
      c.fillRect(0, 0, 320, 180);
      L.pxtext(c, 'OPTIONS', 160, 24, { color: N[0x26], align: 'center' });
      list.forEach((r, i) => {
        const y = 44 + 12 * i;
        L.pxtext(c, r.label, 40, y, { color: N[0x30] });
        const row = ROWS[r.id];
        if (row && row.key) L.pxtext(c, row.show(r.value), 192, y, { color: i === state.sel ? N[0x26] : N[0x30] });
      });
      L.pxtext(c, '▶', 28, 44 + 12 * state.sel, { color: N[0x26] });
      if (off) L.pxtext(c, 'SAVE OFF', 296, 24, { color: N[0x16], align: 'right' });
      L.pxtext(c, 'A SELECT  B BACK', 160, 164, { color: N[0x10], align: 'center' });
    });
  }

  function drawControls(g, state, save) {
    const env = { save };
    const list = items(state, env);
    const bind = state.bind;
    // the waiting slot blinks (32 on, 16 off) on the binding's own step count
    const blink = bind ? (bind.t % 48 < 32 ? 1 : 0) : 0;
    const note = state.note ? state.note.text : '';
    const key = 'controls|' + state.sel + '|' + state.slot + '|' + (bind ? bind.action + bind.slot + blink : '-') + '|' + note + '|' +
      list.map((r) => (r.keys ? r.keys.join('+') : r.id)).join(',');
    GAME.layer(g, 'm-controls', key, 180, (c) => {
      c.fillStyle = N[0x0f];
      c.fillRect(0, 0, 320, 180);
      L.pxtext(c, 'CONTROLS', 160, 20, { color: N[0x26], align: 'center' });
      L.pxtext(c, 'KEY 1', 160, 32, { color: N[0x10] });
      L.pxtext(c, 'KEY 2', 232, 32, { color: N[0x10] });
      list.forEach((r, i) => {
        const y = 44 + 11 * i;
        L.pxtext(c, txt(r.label), 40, y, { color: N[0x30] });
        if (r.keys) {
          for (let k = 0; k < 2; k++) {
            const x0 = 160 + 72 * k;
            const here = i === state.sel && k === state.slot;
            if (bind && here) {
              if (blink) L.pxtext(c, '?', x0, y, { color: N[0x26] });
            } else L.pxtext(c, keyLabel(r.keys[k]), x0, y, { color: here ? N[0x26] : N[0x30] });
            if (here) {
              c.fillStyle = N[0x26];
              c.fillRect(x0, y + 8, 47, 1);
            }
          }
        }
      });
      L.pxtext(c, '▶', 28, 44 + 11 * state.sel, { color: N[0x26] });
      let help = '< > KEY  A SET  B BACK';
      let color = N[0x10];
      if (bind) {
        help = 'PRESS A KEY  ESC CANCELS';
        color = N[0x30];
      } else if (note) {
        help = note;
        color = N[0x16];
      }
      L.pxtext(c, help, 160, 164, { color, align: 'center' });
    });
  }

  function drawConfirm(g, id, question, state) {
    GAME.layer(g, id, question + '|' + state.sel, 180, (c) => {
      panel(c, 80, 52, 240, 148);
      L.pxtext(c, question, 160, 76, { color: N[0x30], align: 'center' });
      L.pxtext(c, 'NO', 152, 104, { color: N[0x30] });
      L.pxtext(c, 'YES', 152, 116, { color: N[0x30] });
      L.pxtext(c, '▶', 138, state.sel ? 116 : 104, { color: N[0x26] });
    });
  }

  function drawPause(g, state, snap) {
    const name = (snap && snap.name) || '';
    const bits = (snap && snap.tokens) | 0;
    const world = (snap && snap.world) || '';
    GAME.layer(g, 'm-pause', 'pause|' + state.sel + '|' + name + '|' + bits + '|' + world, 180, (c) => {
      panel(c, 80, 52, 240, 148);
      L.pxtext(c, 'PAUSED', 160, 60, { color: N[0x30], align: 'center' });
      L.pxtext(c, (world ? world + ' ' : '') + name, 160, 74, { color: N[0x10], align: 'center' });
      tokenRow(c, bits, 88);
      const Y = [104, 116, 128];
      ['RESUME', 'OPTIONS', 'QUIT'].forEach((t, i) => L.pxtext(c, t, 120, Y[i], { color: N[0x30] }));
      L.pxtext(c, '▶', 106, Y[state.sel] || 104, { color: N[0x26] });
    });
  }

  // x: { saveOff } (the shell's storage state)
  function draw(g, state, snap, save, x) {
    libs();
    if (!state) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
    switch (state.screen) {
      case 'title':
        drawTitle(g, state, snap, save);
        break;
      case 'options':
        drawOptions(g, state, save, x);
        break;
      case 'controls':
        drawControls(g, state, save);
        break;
      case 'erase':
        // the confirm stands alone on the options screen's black, so the options cursor and the
        // labels the panel would clip never show beside it
        GAME.layer(g, 'm-options', 'erase', 180, (c) => {
          c.fillStyle = N[0x0f];
          c.fillRect(0, 0, 320, 180);
          L.pxtext(c, 'OPTIONS', 160, 24, { color: N[0x26], align: 'center' });
        });
        drawConfirm(g, 'm-erase', 'ERASE SAVE?', state);
        break;
      case 'pause':
        drawPause(g, state, snap);
        break;
      case 'quit':
        drawConfirm(g, 'm-quit', 'QUIT?', state);
        break;
    }
    g.restore();
  }

  // the attract demo's caption: DEMO centred at y 40, 32 frames on and 32 off, white on a black shadow
  function drawDemo(g, t) {
    libs();
    if ((t | 0) % 64 >= 32) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    GAME.layer(g, 'm-demo', 'demo', 56, (c) => L.pxtext(c, 'DEMO', 160, 40, { color: N[0x30], align: 'center', shadow: N[0x0f] }));
    g.restore();
  }

  GAME.menu = Object.freeze({
    IDLE,
    REMAP_TIMEOUT,
    ACTIONS,
    DEFAULT_KEYS,
    FIXED: Object.freeze(Array.from(FIXED)),
    init,
    step,
    key,
    items,
    draw,
    drawDemo,
    rebind,
    bindable,
    keyLabel,
  });
})();
