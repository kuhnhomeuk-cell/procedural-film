// tools/e2e/lib.cjs : the browser plumbing tools/e2e/run.cjs and tools/game-check.cjs share. Owner: P7.
//
//   const E = require('./lib.cjs');
//   const browser = await E.launch({ gl: 'gpu' | 'swiftshader' });
//   const t = await E.open(browser, url, { profile: 'desktop' | 'pixel7' | 'iphone', query: '?proof=1&clean=1' });
//   t.page, t.errors (console errors + page errors), t.csp (CSP violations), t.requests (URLs), t.docHeaders
//   await t.title()                  wait for FILM.shell.stats.state === 'title'
//   await t.stats(), t.snap()        FILM.shell.stats (plain object) / FILM.shell.proof.snap()
//   await t.steps(n)                 wait until the shell has stepped n more times
//   await t.until(fn, arg, ms)       wait (animation frames) until fn(arg) is truthy in the page
//   await t.key(code, holdSteps)     a trusted key press held for holdSteps shell steps (then released)
//   await t.touch(x, y, holdSteps)   a trusted touch (CDP) held for holdSteps steps
//   E.replay(rec)                    a recorded console tape replayed in Node through the harness:
//                                    { events, fp, frames: [{ mode, lvT, x }], W }
//
// Nothing here is shipped; timing APIs are fine.
'use strict';

const path = require('path');
const fs = require('fs');

const TOOLS = path.resolve(__dirname, '..');
const ROOT = path.resolve(TOOLS, '..');
const PW = require(path.join(TOOLS, 'node_modules', 'playwright'));

// Chromium only (docs/game-spec.md 15.1: no WebKit download). The iPhone profile is an iPhone-sized
// Chromium viewport with touch; it proves the layout and the touch pad, not Safari.
const PIXEL7 = PW.devices['Pixel 7'];
const PROFILES = {
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  pixel7: { viewport: PIXEL7.viewport, screen: PIXEL7.screen, deviceScaleFactor: PIXEL7.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PIXEL7.userAgent },
  iphone: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PIXEL7.userAgent },
};

// gpu: the platform GPU through ANGLE (what a player's desktop has; the timing budgets use it).
// swiftshader: the CPU rasteriser every machine has (the tools' default for pixel hashes).
function glArgs(gl) {
  if (gl === 'swiftshader') return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const a = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  if (process.platform === 'darwin') a.push('--use-angle=metal');
  return a;
}

async function launch({ gl = 'gpu', args = [] } = {}) {
  return PW.chromium.launch({ args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...glArgs(gl), ...args] });
}

// runs in the page before any of its scripts (Playwright injects it outside the page's CSP)
function initScript() {
  window.__e2e = { csp: [], t0: performance.now() };
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__e2e.csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + (e.lineNumber || 0));
  });
}

async function open(browser, url, { profile = 'desktop', query = '?proof=1&clean=1', context = null, init = null } = {}) {
  const ctx = context || (await browser.newContext(Object.assign({}, PROFILES[profile])));
  const page = await ctx.newPage();
  const t = { ctx, page, profile, errors: [], requests: [], docHeaders: null, url };
  page.on('console', (m) => {
    if (m.type() === 'error') t.errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => t.errors.push('pageerror: ' + e.message));
  page.on('request', (r) => t.requests.push(r.url()));
  await page.addInitScript(initScript);
  if (init) await page.addInitScript(init);
  t.goto = async (q = query, pathName = '/') => {
    t.requests.length = 0;
    const resp = await page.goto(url.replace(/\/$/, '') + pathName + q, { waitUntil: 'load' });
    t.docHeaders = resp ? resp.headers() : null;
    t.status = resp ? resp.status() : 0;
    return resp;
  };
  t.csp = () => page.evaluate(() => (window.__e2e ? window.__e2e.csp.slice() : []));
  t.title = (ms = 20000) => page.waitForFunction(() => window.FILM && FILM.shell && FILM.shell.stats.state === 'title', null, { timeout: ms });
  t.stats = () =>
    page.evaluate(() => {
      const s = FILM.shell.stats;
      const o = {};
      for (const k of ['state', 'mode', 'levelId', 'steps', 'rafs', 'rate', 'backend', 'audio', 'save', 'buttons', 'frame']) o[k] = s[k];
      return o;
    });
  t.snap = () => page.evaluate(() => FILM.shell.proof.snap());
  t.until = (fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 'raf' });
  t.steps = async (n, ms) => {
    const s0 = await page.evaluate(() => FILM.shell.stats.steps);
    await t.until((w) => FILM.shell.stats.steps >= w, s0 + n, ms || Math.max(10000, n * 60));
  };
  t.key = async (code, hold = 3) => {
    await page.keyboard.down(code);
    await t.steps(hold);
    await page.keyboard.up(code);
    await t.steps(2);
  };
  let cdp = null;
  t.cdp = async () => cdp || (cdp = await ctx.newCDPSession(page));
  t.touchDown = async (points) => {
    const c = await t.cdp();
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  };
  t.touchUp = async () => {
    const c = await t.cdp();
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  t.touch = async (x, y, hold = 4) => {
    await t.touchDown([[x, y]]);
    await t.steps(hold);
    await t.touchUp();
    await t.steps(2);
  };
  t.rect = (sel) =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }, sel);
  t.close = () => (context ? page.close() : ctx.close());
  return t;
}

// ------------------------------------------------------------------------------------------------
// Node-side replay of a console tape recorded in the page (FILM.shell.proof.record())
// ------------------------------------------------------------------------------------------------
let G = null;
function replay(rec) {
  if (!G) G = require(path.join(TOOLS, 'proof', 'harness.cjs')).load();
  const bytes = G.decode(rec.rle);
  const c = G.game.create(rec.opts || {});
  const events = [];
  const frames = [];
  for (let i = 0; i < bytes.length; i++) {
    const ev = c.step(bytes[i]);
    for (const e of ev) events.push(Object.assign({ i }, e));
    const W = c.state();
    frames.push({ mode: W.mode, lvT: W.lv ? W.lv.t : null, x: W.p ? W.p.x : null, b: bytes[i] });
  }
  return { events, frames, fp: G.fingerprint(events, c.state().score), W: c.state(), bytes };
}

function tape(name) {
  return JSON.parse(fs.readFileSync(path.join(TOOLS, 'proof', 'tapes', name + '.json'), 'utf8'));
}

module.exports = { PW, PROFILES, launch, open, replay, tape, ROOT, TOOLS };
