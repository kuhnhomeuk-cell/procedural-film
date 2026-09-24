#!/usr/bin/env node
// tools/proof/menu.cjs : the menu proof (docs/game-spec.md 11.4, 11.5 and 13.5). Owner: P6.
//
//   node tools/proof/menu.cjs     exits 1 on any failure
//
// Drives GAME.menu.step (src/game/50-menu.js) through every screen with button edges and asserts the
// actions, the sounds, the skipping of disabled rows, swap-on-rebind (never a key bound twice), the
// refusal of fixed and modifier keys, the binding timeout and the title's idle-to-demo action at exactly
// 1080 steps. Every state handed to step() is deep-frozen, so a mutation throws (the menus are pure).
// Then paints every screen into a recording canvas and checks every colour it uses is a FILM.retro.NES colour.
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');

// the harness loads the drawn library and the retro kit (FILM.retro: FONT, NES) itself; loading lib.js a
// second time would reassign the frozen FILM.lib
const G = H.load();
const FILM = G.FILM;
const GAME = G.GAME;
const M = GAME.menu;
const B = GAME.BUTTONS;
const CONFIG = GAME.CONFIG || {};
const ORDER = CONFIG.order && CONFIG.order.length ? CONFIG.order : [CONFIG.firstLevel];

let fails = 0;
function check(name, ok, got) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${got !== undefined ? ': ' + got : ''}`);
  if (!ok) fails++;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) freeze(o[k]);
  }
  return o;
}

function save(over) {
  const s = {
    v: 1, hi: 12345, reach: CONFIG.firstLevel, cleared: false, tokens: Object.fromEntries(ORDER.map((id) => [id, 0])),
    settings: { feel: 'modern', crt: 'on', vol: 8, mute: false, input: false, flash: 'full', keys: clone(M.DEFAULT_KEYS) },
  };
  return Object.assign(s, over || {});
}
// env with a mutable save: 'set' and 'erase' actions are applied as the shell would
function makeEnv(over, fromPause) {
  return { save: save(over), fromPause: !!fromPause, saveOff: false };
}
function apply(env, action) {
  if (!action) return;
  if (action.type === 'set') env.save.settings[action.key] = clone(action.value);
  if (action.type === 'erase') env.save = save();
}
// press a sequence of button edges; returns the last result and every action and sound seen
function press(state, seq, env) {
  const actions = [];
  const sounds = [];
  let r = { state };
  for (const b of seq) {
    r = M.step(freeze(r.state), b, env);
    if (r.action) actions.push(r.action);
    if (r.sound) sounds.push(r.sound);
    apply(env, r.action);
  }
  return Object.assign({}, r, { actions, sounds });
}
const row = (st, env) => M.items(st, env)[st.sel].id;

// ------------------------------------------------------------------------------------------ title
{
  const env = makeEnv({ reach: CONFIG.firstLevel });
  let s = M.init('title', env);
  const it = M.items(s, env);
  check('title rows', it.map((r) => r.label).join(',') === 'NEW GAME,CONTINUE,OPTIONS' && it[1].disabled === true, it.map((r) => r.label + (r.disabled ? '(off)' : '')).join(','));
  check('title starts on NEW GAME', row(s, env) === 'new');
  let r = press(s, [B.DOWN], env);
  check('DOWN skips a disabled CONTINUE', row(r.state, env) === 'options' && r.sounds[0] === 'cursor', row(r.state, env));
  r = press(s, [B.UP], env);
  check('UP wraps to OPTIONS', row(r.state, env) === 'options', row(r.state, env));
  r = press(s, [B.SELECT, B.SELECT], env);
  check('SELECT cycles past CONTINUE', row(r.state, env) === 'new', row(r.state, env));
  r = press(s, [B.START], env);
  check('START on NEW GAME: new', r.actions.length === 1 && r.actions[0].type === 'new' && r.sounds[0] === 'select', JSON.stringify(r.actions));
  r = press(s, [B.A], env);
  check('A on NEW GAME: new', r.actions[0] && r.actions[0].type === 'new');
  r = press(s, [B.B, B.LEFT, B.RIGHT], env);
  check('B, LEFT and RIGHT on the title do nothing', r.actions.length === 0 && r.sounds.length === 0 && r.state.screen === 'title' && row(r.state, env) === 'new');

  const env3 = makeEnv({ reach: '1-3' });
  s = M.init('title', env3);
  const it3 = M.items(s, env3);
  check('CONTINUE 1-3 enabled with reach 1-3', it3[1].label === 'CONTINUE 1-3' && !it3[1].disabled, it3[1].label);
  r = press(s, [B.DOWN, B.A], env3);
  check('CONTINUE: continue at the reached level', r.actions[0] && r.actions[0].type === 'continue' && r.actions[0].level === '1-3', JSON.stringify(r.actions[0]));
  r = press(s, [B.DOWN, B.DOWN, B.A], env3);
  check('OPTIONS opens the options screen (from title)', r.state.screen === 'options' && r.state.from === 'title' && r.actions.length === 0, r.state.screen);
}

// ------------------------------------------------------------------------------------------ idle to demo
{
  const env = makeEnv();
  let s = M.init('title', env);
  let demoAt = -1;
  for (let i = 1; i <= 1200 && demoAt < 0; i++) {
    const r = M.step(freeze(s), 0, env);
    if (r.action && r.action.type === 'demo') demoAt = i;
    s = r.state;
  }
  check('idle: demo at exactly 1080 steps', demoAt === 1080 && M.IDLE === 1080, demoAt);
  // a button edge resets the count
  s = M.init('title', env);
  let first = -1;
  for (let i = 1; i <= 2400 && first < 0; i++) {
    const r = M.step(freeze(s), i === 1000 ? B.RIGHT : 0, env);
    if (r.action && r.action.type === 'demo') first = i;
    s = r.state;
  }
  check('idle: a button edge at step 1000 restarts the count', first === 2080, first);
  // held buttons are not edges: only edges reset it (the shell passes edges)
  s = M.init('options', env);
  let any = false;
  for (let i = 0; i < 1500; i++) {
    const r = M.step(freeze(s), 0, env);
    if (r.action) any = true;
    s = r.state;
  }
  check('idle: only the title counts (options never starts the demo)', !any);
}

// ------------------------------------------------------------------------------------------ options
{
  const env = makeEnv();
  let s = M.init('options', env);
  const it = M.items(s, env);
  check('options (title) rows', it.map((x) => x.label).join(',') === 'FEEL,DISPLAY,VOLUME,INPUT DISPLAY,FLASHING,CONTROLS,ERASE SAVE,BACK', it.map((x) => x.label).join(','));
  let r = press(s, [B.RIGHT], env);
  check('FEEL RIGHT: set feel nes', r.actions[0] && r.actions[0].key === 'feel' && r.actions[0].value === 'nes' && r.sounds[0] === 'cursor', JSON.stringify(r.actions[0]));
  r = press(r.state, [B.LEFT], env);
  check('FEEL LEFT: back to modern', env.save.settings.feel === 'modern');
  r = press(M.init('options', env), [B.DOWN, B.A], env);
  check('DISPLAY A: crt off', r.actions[0] && r.actions[0].key === 'crt' && r.actions[0].value === 'off');
  press(r.state, [B.A], env);
  check('DISPLAY A again: crt on', env.save.settings.crt === 'on');
  // volume: RIGHT to 10 clamps, LEFT to 0 clamps, A wraps
  s = press(M.init('options', env), [B.DOWN, B.DOWN], env).state;
  check('cursor on VOLUME', row(s, env) === 'vol');
  r = press(s, [B.RIGHT, B.RIGHT, B.RIGHT, B.RIGHT], env);
  check('VOLUME RIGHT clamps at 10', env.save.settings.vol === 10 && r.actions.length === 2, `${env.save.settings.vol} after ${r.actions.length} sets`);
  r = press(s, [B.A], env);
  check('VOLUME A wraps 10 to 0', env.save.settings.vol === 0, env.save.settings.vol);
  r = press(s, [B.LEFT], env);
  check('VOLUME LEFT at 0 does nothing', r.actions.length === 0 && env.save.settings.vol === 0);
  r = press(s, [B.DOWN, B.RIGHT], env);
  check('INPUT DISPLAY RIGHT: on', env.save.settings.input === true);
  r = press(s, [B.DOWN, B.DOWN, B.RIGHT], env);
  check('FLASHING RIGHT: reduced', env.save.settings.flash === 'reduced');
  // CONTROLS, ERASE SAVE and BACK
  r = press(M.init('options', env), [B.UP, B.UP, B.UP, B.A], env);
  check('CONTROLS opens the controls screen', r.state.screen === 'controls' && r.sounds.slice(-1)[0] === 'select', r.state.screen);
  r = press(r.state, [B.B], env);
  check('B from controls: options with the cursor on CONTROLS', r.state.screen === 'options' && row(r.state, env) === 'controls' && r.sounds[0] === 'back');
  r = press(M.init('options', env), [B.UP, B.UP, B.A], env);
  check('ERASE SAVE: confirm with the cursor on NO', r.state.screen === 'erase' && row(r.state, env) === 'no', r.state.screen + ' ' + row(r.state, env));
  const er = r.state;
  r = press(er, [B.A], env);
  check('erase NO: back to options, nothing erased', r.state.screen === 'options' && row(r.state, env) === 'erase' && r.actions.length === 0);
  r = press(er, [B.B], env);
  check('erase B: back to options', r.state.screen === 'options' && r.actions.length === 0);
  env.save.hi = 999;
  r = press(er, [B.DOWN, B.A], env);
  check('erase YES: erase action, back on options', r.actions[0] && r.actions[0].type === 'erase' && r.state.screen === 'options' && env.save.hi === 12345, JSON.stringify(r.actions));
  r = press(er, [B.RIGHT], env);
  check('erase RIGHT toggles to YES', row(r.state, env) === 'yes');
  r = press(M.init('options', env), [B.UP, B.A], env);
  check('BACK: title with the cursor on OPTIONS', r.state.screen === 'title' && row(r.state, env) === 'options' && r.sounds.slice(-1)[0] === 'back');
  r = press(M.init('options', env), [B.B], env);
  check('B from options (title): title', r.state.screen === 'title');
}

// ------------------------------------------------------------------------------------------ pause
{
  const env = makeEnv({}, true);
  const s = M.init('pause', env);
  check('pause rows', M.items(s, env).map((x) => x.label).join(',') === 'RESUME,OPTIONS,QUIT');
  let r = press(s, [B.START], env);
  check('pause START: resume', r.actions[0] && r.actions[0].type === 'resume');
  r = press(s, [B.DOWN, B.DOWN, B.START], env);
  check('pause START resumes wherever the cursor is', r.actions[0] && r.actions[0].type === 'resume');
  r = press(s, [B.A], env);
  check('pause A on RESUME: resume', r.actions[0] && r.actions[0].type === 'resume');
  r = press(s, [B.B], env);
  check('pause B: resume', r.actions[0] && r.actions[0].type === 'resume' && r.sounds[0] === 'back');
  r = press(s, [B.DOWN, B.A], env);
  check('pause OPTIONS: options from pause', r.state.screen === 'options' && r.state.from === 'pause');
  const it = M.items(r.state, env).map((x) => x.label).join(',');
  check('options (pause) rows: no FEEL, no ERASE SAVE', it === 'DISPLAY,VOLUME,INPUT DISPLAY,FLASHING,CONTROLS,BACK', it);
  const r2 = press(r.state, [B.B], env);
  check('B from options (pause): pause with the cursor on OPTIONS', r2.state.screen === 'pause' && row(r2.state, env) === 'options');
  const r3 = press(r.state, [B.UP, B.UP, B.A, B.B, B.B], env);
  check('controls from pause and back out twice: pause', r3.state.screen === 'pause', r3.state.screen);
  r = press(s, [B.UP, B.A], env);
  check('QUIT: confirm with the cursor on NO', r.state.screen === 'quit' && row(r.state, env) === 'no');
  const q = r.state;
  r = press(q, [B.A], env);
  check('quit NO: pause with the cursor on QUIT', r.state.screen === 'pause' && row(r.state, env) === 'quit' && r.actions.length === 0);
  r = press(q, [B.B], env);
  check('quit B: pause', r.state.screen === 'pause' && r.actions.length === 0);
  r = press(q, [B.DOWN, B.A], env);
  check('quit YES: quit action', r.actions[0] && r.actions[0].type === 'quit');
}

// ------------------------------------------------------------------------------------------ controls and rebinding
{
  const env = makeEnv();
  let s = M.init('controls', env);
  const it = M.items(s, env);
  check('controls rows', it.map((x) => x.id).join(',') === 'UP,DOWN,LEFT,RIGHT,A,B,START,SELECT,reset,back' && it[4].label === 'A (JUMP)' && it[5].label === 'B (RUN/THROW)', it.map((x) => x.label).join(','));
  check('each action row shows its two slots', it.slice(0, 8).every((x) => x.keys.length === 2), it[0].keys.join(' '));
  // A row, slot 0: bind KeyX (B's slot 0) -> swap
  let r = press(s, [B.DOWN, B.DOWN, B.DOWN, B.DOWN], env);
  check('cursor on A (JUMP)', row(r.state, env) === 'A');
  r = press(r.state, [B.A], env);
  check('A starts binding', r.state.bind && r.state.bind.action === 'A' && r.state.bind.slot === 0 && r.actions[0].type === 'bind' && r.actions[0].action === 'A' && r.actions[0].slot === 0, JSON.stringify(r.actions[0]));
  const binding = r.state;
  let k = M.key(freeze(binding), 'KeyX', env);
  apply(env, k.action);
  const ks = env.save.settings.keys;
  check('swap-on-rebind: A gets X, B gets Z', ks.A[0] === 'KeyX' && ks.B[0] === 'KeyZ' && ks.A[1] === 'KeyK' && ks.B[1] === 'KeyJ' && !k.state.bind, `A ${ks.A} B ${ks.B}`);
  // the same action's other slot: a swap inside the row
  k = M.key(freeze(Object.assign({}, binding, { bind: { action: 'A', slot: 0, t: 0 } })), 'KeyK', env);
  apply(env, k.action);
  check('rebinding to its own other slot swaps the pair', env.save.settings.keys.A[0] === 'KeyK' && env.save.settings.keys.A[1] === 'KeyX', env.save.settings.keys.A.join(','));
  // refusals: fixed keys and modifier-only keys; the binding waits on
  for (const code of ['KeyP', 'Escape', 'KeyF', 'KeyC', 'KeyM', 'KeyI', 'ControlLeft', 'AltRight', 'MetaLeft']) {
    const before = JSON.stringify(env.save.settings.keys);
    const rr = M.key(freeze(clone(binding)), code, env);
    const ok = code === 'Escape' ? !rr.state.bind && !rr.action : !!rr.state.bind && !rr.action && rr.state.note && JSON.stringify(env.save.settings.keys) === before;
    check(`${code} ${code === 'Escape' ? 'cancels the binding' : 'is refused, binding waits'}`, ok, rr.state.note ? rr.state.note.text : 'no note');
  }
  // SHIFT is a console button (SELECT's default), so it can be bound
  check('ShiftLeft is bindable', M.bindable('ShiftLeft') && M.bindable('Space') && !M.bindable('') && !M.bindable('Unidentified'));
  // timeout: 300 steps without a key
  s = binding;
  let steps = 0;
  while (s.bind && steps < 400) {
    s = M.step(freeze(s), 0, env).state;
    steps++;
  }
  check('binding gives up after 300 steps', steps === 300 && !s.bind, steps);
  // RIGHT picks slot 1, binding then goes to slot 1
  r = press(M.init('controls', env), [B.RIGHT, B.A], env);
  check('RIGHT picks slot 2, A binds it', r.state.bind && r.state.bind.action === 'UP' && r.state.bind.slot === 1);
  r = press(M.init('controls', env), [B.RIGHT, B.LEFT], env);
  check('LEFT picks slot 1 again', r.state.slot === 0 && r.sounds.join() === 'cursor,cursor');
  // RESET DEFAULTS
  r = press(M.init('controls', env), [B.UP, B.UP, B.A], env);
  check('RESET DEFAULTS restores every binding', JSON.stringify(env.save.settings.keys) === JSON.stringify(clone(M.DEFAULT_KEYS)) && r.actions[0].key === 'keys');
  r = press(M.init('controls', env), [B.UP, B.A], env);
  check('BACK: options', r.state.screen === 'options');
  // a long seeded run of rebinds never binds a key twice
  let seed = 12345;
  const rnd = (n) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const pool = ['KeyQ', 'KeyW', 'KeyE', 'KeyZ', 'KeyX', 'Space', 'ArrowUp', 'ArrowLeft', 'Enter', 'ShiftLeft', 'Digit1', 'Numpad4', 'KeyK', 'KeyJ', 'KeyP', 'ControlLeft', 'Semicolon'];
  let keys = clone(M.DEFAULT_KEYS);
  let dup = 0;
  let refused = 0;
  for (let i = 0; i < 5000; i++) {
    const next = M.rebind(keys, M.ACTIONS[rnd(8)], rnd(2), pool[rnd(pool.length)]);
    if (!next) {
      refused++;
      continue;
    }
    keys = next;
    const all = M.ACTIONS.flatMap((a) => keys[a]);
    if (new Set(all).size !== all.length || all.length !== 16) dup++;
  }
  check('5000 random rebinds: never a key bound twice, every slot filled', dup === 0 && refused > 0, `${dup} duplicates, ${refused} refused`);
}

// ------------------------------------------------------------------------------------------ labels
{
  const want = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Space: 'SPACE', Enter: 'ENTER', NumpadEnter: 'NENTER',
    ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', KeyZ: 'Z', Digit1: '1', Numpad1: 'NUM1', Semicolon: 'SEMICO', BracketLeft: 'BRACKE', Minus: 'MINUS', F5: 'F5', Backquote: 'BACKQU' };
  const bad = Object.keys(want).filter((c) => M.keyLabel(c) !== want[c]).map((c) => `${c}=${M.keyLabel(c)}`);
  check('key labels (11.4 table and the fallback rule)', bad.length === 0, bad.join(' ') || Object.keys(want).length + ' labels');
  const glyphs = new Set(Object.keys(FILM.retro.FONT));
  const allLabels = ['ArrowUp', 'Space', 'NumpadEnter', 'Semicolon', 'IntlBackslash', 'AudioVolumeUp'].map(M.keyLabel).join('');
  check('labels use only font glyphs', [...allLabels].every((c) => glyphs.has(c)), allLabels);
}

// ------------------------------------------------------------------------------------------ painting
{
  const NES = new Set(FILM.retro.NES.map((c) => c.toUpperCase()));
  const used = new Set();
  let draws = 0;
  function fakeCtx(c) {
    const g = {
      canvas: c, fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
      save() {}, restore() {}, setTransform() {}, translate() {}, scale() {}, clearRect() {},
      fillRect() {
        used.add(String(g.fillStyle).toUpperCase());
        draws++;
      },
      drawImage() {},
    };
    return g;
  }
  FILM.makeCanvas = (w, h) => {
    const c = { width: w, height: h };
    c.getContext = () => fakeCtx(c);
    return c;
  };
  const g = fakeCtx({ width: 320, height: 180 });
  const env = makeEnv({ reach: '1-2' });
  const snap = { top: 4200, name: 'LEVEL 1-2', world: '1-2', tokens: 5 };
  const screens = [
    M.init('title', env),
    M.init('options', env),
    M.init('options', makeEnv({}, true)),
    press(M.init('options', env), [B.UP, B.UP, B.A], env).state,
    M.init('controls', env),
    press(M.init('controls', env), [B.A], env).state,
    M.init('pause', env),
    press(M.init('pause', env), [B.UP, B.A], env).state,
  ];
  let err = null;
  try {
    for (const s of screens) M.draw(g, s, snap, env.save, { saveOff: true });
    for (let t = 0; t < 64; t++) M.drawDemo(g, t);
  } catch (e) {
    err = e;
  }
  const off = [...used].filter((c) => !NES.has(c));
  check('every screen paints without throwing', !err, err ? err.message : `${screens.map((s) => s.screen).join(',')}`);
  check('every colour painted is a FILM.retro.NES colour', off.length === 0 && draws > 0, off.length ? off.join(' ') : `${used.size} colours, ${draws} fills`);
}

// ------------------------------------------------------------------------------------------ purity
{
  const env = makeEnv();
  const s = freeze(M.init('title', env));
  let threw = null;
  try {
    for (const b of [0, B.DOWN, B.A, B.B, B.LEFT, B.RIGHT, B.START, B.SELECT]) M.step(s, b, env);
    for (const sc of ['options', 'controls', 'pause', 'quit', 'erase']) for (const b of [0, B.DOWN, B.A, B.B, B.RIGHT]) M.step(freeze(M.init(sc, env)), b, env);
  } catch (e) {
    threw = e;
  }
  check('step never mutates the state it is given', !threw, threw ? threw.message : 'frozen states stepped');
  check('GAME.menu is frozen', Object.isFrozen(M));
}

console.log(fails ? `menu: ${fails} failure(s)` : 'menu: all checks pass');
process.exit(fails ? 1 : 0);
