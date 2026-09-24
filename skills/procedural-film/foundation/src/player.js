/*
 * player.js : the interactive page around the film.
 *
 *   click or space   play / pause (with audio)
 *   left / right     step one frame back / forward
 *   ?t=seconds       open paused on that global time
 *   ?shot=id         loop one shot
 *   ?render=1        no UI, canvas at native size, nothing drawn until asked (used by tools)
 *
 * The clock while playing is the AudioContext clock when there is music, otherwise the
 * requestAnimationFrame timestamp. Nothing here draws: it only calls FILM.renderFrame(T).
 */
(function () {
  'use strict';

  const FILM = window.FILM;
  if (!FILM || typeof FILM.renderFrame !== 'function') return;

  const params = new URLSearchParams(window.location.search);
  const renderMode = params.get('render') === '1';

  if (renderMode) {
    // tools mount their own canvas; keep the page inert
    document.documentElement.style.background = '#000';
    return;
  }

  function start() {
    if (FILM.TIMELINE) FILM.prepare(); // applies a timeline-declared fps before it is read
    const FPS = FILM.FPS;
    const duration = FILM.DURATION;
    const shotId = params.get('shot');
    const loopShot = shotId ? FILM.shotById(shotId) : null;
    const rangeStart = loopShot ? loopShot.start : 0;
    const rangeEnd = loopShot ? loopShot.end : duration;
    const tParam = params.get('t');

    const style = document.createElement('style');
    style.textContent = [
      'html,body{margin:0;height:100%;background:#000;overflow:hidden}',
      'body{display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-user-select:none;user-select:none}',
      `#film{display:block;height:min(100vh,calc(100vw*${FILM.H}/${FILM.W}));width:auto;` +
        `aspect-ratio:${FILM.W}/${FILM.H};background:#000}`,
      '#hud{position:fixed;left:0;right:0;bottom:0;padding:10px 14px;font:12px/1.4 ui-monospace,Menlo,monospace;color:#bbb;',
      'display:flex;justify-content:space-between;pointer-events:none;transition:opacity .4s;text-shadow:0 1px 2px #000}',
      '#bar{position:fixed;left:0;bottom:0;height:2px;background:#e8e0cf;width:0;pointer-events:none}',
      'body.playing #hud{opacity:0}',
      'body.playing:hover #hud{opacity:.85}',
    ].join('');
    document.head.appendChild(style);

    const canvas = document.createElement('canvas');
    canvas.id = 'film';
    document.body.appendChild(canvas);
    FILM.mount(canvas);

    const hud = document.createElement('div');
    hud.id = 'hud';
    const left = document.createElement('span');
    const right = document.createElement('span');
    right.textContent = 'click or space: play/pause   ← →: step';
    hud.appendChild(left);
    hud.appendChild(right);
    document.body.appendChild(hud);
    const bar = document.createElement('div');
    bar.id = 'bar';
    document.body.appendChild(bar);

    let T = tParam != null && isFinite(Number(tParam)) ? Number(tParam) : rangeStart;
    let playing = false;
    let audio = null; // { ctx, anchor, startT }
    let rafStamp0 = null;
    let rafT0 = 0;
    let lastDrawn = -1;

    const quant = (t) => Math.floor(t * FPS + 1e-6) / FPS;

    function draw(force) {
      const q = quant(Math.min(Math.max(T, rangeStart), rangeEnd - 1 / FPS));
      if (!force && q === lastDrawn) return;
      lastDrawn = q;
      FILM.errors = [];
      const shot = FILM.renderFrame(q);
      if (FILM.errors.length && window.console) console.warn('FILM errors at', q, FILM.errors);
      left.textContent = `${q.toFixed(2)}s  f${Math.round(q * FPS)}  ${shot ? shot.id : ''}`;
      bar.style.width = `${(100 * (q - rangeStart)) / Math.max(1e-6, rangeEnd - rangeStart)}%`;
    }

    function stopAudio() {
      if (audio) {
        const c = audio.ctx;
        audio = null;
        c.close();
      }
    }

    function startAudio(fromT) {
      stopAudio();
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !FILM.audio || typeof FILM.audio.render !== 'function') return;
      const ctx = new AC({ latencyHint: 'playback', sampleRate: 48000 });
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const anchor = ctx.currentTime;
      try {
        FILM.audio.render(ctx, { start: fromT, dest: master });
      } catch (e) {
        if (window.console) console.error('FILM.audio.render failed', e);
      }
      audio = { ctx, anchor, startT: fromT };
    }

    function play() {
      if (T >= rangeEnd - 1 / FPS) T = rangeStart;
      playing = true;
      document.body.classList.add('playing');
      startAudio(T);
      rafStamp0 = null;
      rafT0 = T;
    }

    function pause() {
      playing = false;
      document.body.classList.remove('playing');
      stopAudio();
      T = quant(T);
      draw(true);
    }

    function tick(stamp) {
      if (playing) {
        if (audio) {
          const lat = (audio.ctx.baseLatency || 0) + (audio.ctx.outputLatency || 0);
          T = audio.startT + Math.max(0, audio.ctx.currentTime - audio.anchor - lat);
        } else {
          if (rafStamp0 == null) rafStamp0 = stamp;
          T = rafT0 + (stamp - rafStamp0) / 1000;
        }
        if (T >= rangeEnd) {
          T = rangeStart;
          if (audio) startAudio(T);
          rafStamp0 = stamp;
          rafT0 = T;
        }
        draw(false);
      }
      window.requestAnimationFrame(tick);
    }

    function step(n) {
      if (playing) pause();
      const f = Math.round(quant(T) * FPS) + n;
      const f0 = Math.round(rangeStart * FPS);
      const f1 = Math.round(rangeEnd * FPS) - 1;
      T = Math.min(f1, Math.max(f0, f)) / FPS;
      draw(true);
    }

    canvas.addEventListener('click', () => (playing ? pause() : play()));
    document.body.addEventListener('click', (e) => {
      if (e.target === document.body) playing ? pause() : play();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        playing ? pause() : play();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    });

    draw(true);
    window.requestAnimationFrame(tick);
  }

  // Photos decode asynchronously and the hand-lettering face resolves asynchronously; drawing before
  // either is ready shows a half-built frame (and hashes differently from the same frame drawn later).
  const boot = () =>
    Promise.all([
      FILM.loadPhotos ? FILM.loadPhotos() : Promise.resolve(),
      document.fonts ? document.fonts.ready : Promise.resolve(),
    ]).then(start);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
