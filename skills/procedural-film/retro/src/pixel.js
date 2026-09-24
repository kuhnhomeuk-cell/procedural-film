/*
 * pixel.js : FILM.retro, the retro pixel kit (loaded after lib.js, before a film's sprites.js).
 *
 * FILM.lib is frozen, so the kit lives on its own namespace FILM.retro (a plain object).
 * A film's src/sprites.js fills FILM.retro.SPRITES_DEF, FILM.retro.SPAL and FILM.retro.RETRO_PAL.
 * Everything draws on the native frame buffer (FILM.native(), default 320x180), one canvas px
 * per game px; FILM.presentNearest or crt.js scales it to the output.
 * Also defines FILM.nes (the motion kit) and FILM.transitions.fade (the NES palette fade).
 * Pure functions of their arguments; randomness only from FILM.lib.rng or FILM.lib.hash.
 */
(function () {
  'use strict';

  const FILM = (window.FILM = window.FILM || {});
  const R = (FILM.retro = FILM.retro || {});
  const EPS = 1e-6;

  // ===========================================================================
  // NES master palette
  // ===========================================================================

  /**
   * NES: the 64-entry NES 2C02 master palette as FCEUX shows it, indexed $00..$3F
   * ($22 #5C94FC sky, $17 #C84C0C, $27 #FC9838, $0F #000000, $30 #FCFCFC).
   * $0D/$0E/$0F and the unused $xE/$xF columns are all black, $20 and $30 are both white.
   */
  const NES = Object.freeze([
    '#747474', '#24188C', '#0000A8', '#44009C', '#8C0074', '#A80010', '#A40000', '#7C0800',
    '#402C00', '#004400', '#005000', '#003C14', '#183C5C', '#000000', '#000000', '#000000',
    '#BCBCBC', '#0070EC', '#2038EC', '#8000F0', '#BC00BC', '#E40058', '#D82800', '#C84C0C',
    '#887000', '#009400', '#00A800', '#009038', '#008088', '#000000', '#000000', '#000000',
    '#FCFCFC', '#3CBCFC', '#5C94FC', '#CC88FC', '#F478FC', '#FC74B4', '#FC7460', '#FC9838',
    '#F0BC3C', '#80D010', '#4CDC48', '#58F898', '#00E8D8', '#787878', '#000000', '#000000',
    '#FCFCFC', '#A8E4FC', '#C4D4FC', '#D4C8FC', '#FCC4FC', '#FCC4D8', '#FCBCB0', '#FCD8A8',
    '#FCE4A0', '#E0FCA0', '#A8F0BC', '#B0FCCC', '#9CFCF0', '#C4C4C4', '#000000', '#000000',
  ]);
  R.NES = NES;
  /** nesIndex(hex) : the first NES index whose colour is hex ('#rrggbb', any case), or -1. */
  R.nesIndex = (hex) => (typeof hex === 'string' ? NES.indexOf(hex.toUpperCase()) : -1);

  /** RETRO_PAL : the film's named colours (every value an NES entry); src/sprites.js fills it. */
  R.RETRO_PAL = R.RETRO_PAL || {};

  // ===========================================================================
  // Pixel kit
  // ===========================================================================
  //
  // The film is drawn on a virtual low-resolution grid: VW x VH game pixels. Sprites are string
  // maps drawn once to tiny offscreen canvases and blitted with smoothing off, so edges stay hard.
  // Everything snaps to whole game pixels.
  //
  // NES rules (art bible): every colour is a NES entry, every sprite map uses at most 3 colours
  // plus transparent ('.'), shapes sit on 8x8 tiles / 16x16 metatiles.

  const PX = 1;
  R.PX = PX;
  R.VW = 320; // native width in game px (x6 = 1920)
  R.VH = 180; // native height in game px (x6 = 1080)

  /** px(ctx, gx, gy, gw, gh, color, alpha) : a solid block in game-pixel units. */
  R.px = (ctx, gx, gy, gw, gh, color, alpha) => {
    ctx.save();
    if (alpha != null) ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(gx) * PX, Math.round(gy) * PX, Math.round(gw) * PX, Math.round(gh) * PX);
    ctx.restore();
  };

  // Sprite maps: SPRITES_DEF[name] = { l, r } : r is rows of equal-length strings, l the legend
  // mapping a char to an NES colour. '.' (or any char missing from the legend) is transparent.
  // `legends` (instead of `l`) holds palette-cycle frames, picked by o.frame.
  // Character sprites use only the slot keys '1' '2' '3', so sprite's o.pal can swap them like an
  // NES sprite palette; tiles key their legend by letters, e.g. { a: fill, b: shade, k: outline }.
  // SPAL[name] = [slot1, slot2, slot3] (or an array of such for a cycle) is a character's palettes.
  const SP = (R.SPRITES_DEF = R.SPRITES_DEF || {});
  R.SPAL = R.SPAL || {};
  /** C(i) : an NES colour by its $index. */
  R.C = (i) => NES[i];
  /** slots(p) : the legend { 1, 2, 3 } of a [slot1, slot2, slot3] palette. */
  R.slots = (p) => ({ 1: p[0], 2: p[1], 3: p[2] });

  function newCanvas(w, h) {
    if (FILM.makeCanvas) return FILM.makeCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Sprites blit through tiny 1:1 canvases, cached forever: a canvas is a pure function of
  // (name, legend frame, palette, flip, flipV).
  const spriteCanvases = new Map();
  const palKeys = new WeakMap(); // palette array -> its cache-key string (frozen arrays only, so this is stable)
  const palKey = (p) => {
    let k = palKeys.get(p);
    if (k === undefined) palKeys.set(p, (k = p.join(',')));
    return k;
  };
  function spriteCanvas(name, frame, spal, flip, flipV) {
    const key = name + '|' + (frame || 0) + '|' + (spal ? (Object.isFrozen(spal) ? palKey(spal) : spal.join(',')) : '') + '|' + (flip ? 1 : 0) + (flipV ? 1 : 0);
    let c = spriteCanvases.get(key);
    if (c) return c;
    let def = SP[name];
    if (!def) {
      // a name declared in src/manifest.js but not drawn yet blits a placeholder of its declared size
      // (a magenta box with a dark outline), so the film can be built before its art lands.
      const m = FILM.SPRITE_MANIFEST && FILM.SPRITE_MANIFEST[name];
      if (!m) throw new Error('unknown sprite: ' + name);
      const rows = [];
      for (let y = 0; y < m.h; y++) {
        let r = '';
        for (let x = 0; x < m.w; x++) r += x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1 ? 'k' : 'm';
        rows.push(r);
      }
      def = { l: { k: NES[0x0f], m: NES[0x24] }, r: rows };
    }
    let legend = def.legends ? def.legends[(frame || 0) % def.legends.length] : def.l;
    if (spal) {
      legend = Object.assign({}, legend);
      for (let i = 0; i < 3; i++) if (spal[i]) legend[i + 1] = spal[i];
    }
    const rows = def.r;
    const w = rows[0].length;
    const h = rows.length;
    c = newCanvas(w, h);
    const g = c.getContext('2d');
    for (let y = 0; y < h; y++) {
      const row = rows[flipV ? h - 1 - y : y];
      for (let x = 0; x < w; x++) {
        const col = legend[row[flip ? w - 1 - x : x]];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    c.__gw = w;
    c.__gh = h;
    spriteCanvases.set(key, c);
    return c;
  }
  R.spriteCanvas = spriteCanvas;
  /** hasSprite(name) : true when name is drawn in SPRITES_DEF or declared in the manifest. */
  R.hasSprite = (name) => !!(SP[name] || (FILM.SPRITE_MANIFEST && FILM.SPRITE_MANIFEST[name]));

  /**
   * sprite(ctx, name, gx, gy, o) : blit a named sprite with its top-left at game px (gx, gy).
   *   o.pal [c1, c2, c3] swaps the slot colours '1' '2' '3' (a null entry keeps the sprite's own),
   *   o.flip mirrors horizontally, o.flipV vertically, o.frame picks a legend variant,
   *   o.scale multiplies the size (integer, crisp), o.alpha fades.
   *   Positions snap to whole game pixels. Returns the drawn size { w, h } in game px.
   */
  R.sprite = (ctx, name, gx, gy, o = {}) => {
    const img = spriteCanvas(name, o.frame, o.pal, o.flip, o.flipV);
    const sc = o.scale || 1;
    const x = Math.round(gx) * PX;
    const y = Math.round(gy) * PX;
    if (sc === 1 && PX === 1 && o.alpha == null) {
      ctx.drawImage(img, x, y);
    } else {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      if (o.alpha != null) ctx.globalAlpha *= o.alpha;
      ctx.drawImage(img, x, y, img.__gw * sc * PX, img.__gh * sc * PX);
      ctx.restore();
    }
    return { w: img.__gw * sc, h: img.__gh * sc };
  };

  /**
   * shimmer(f) : a blink drawing 0..2 at global frame f (60 Hz). The cycle is 48 frames:
   * drawing 0 for 24, then 1, 2, 1 for 8 each.
   */
  R.shimmer = (f) => {
    const k = ((Math.floor(f) % 48) + 48) % 48;
    return k < 24 ? 0 : k < 32 ? 1 : k < 40 ? 2 : 1;
  };

  // ---------------------------------------------------------------------------
  // Pixel font (8x8 cells, 7x7 bold glyphs with 2-px strokes) and HUD
  // ---------------------------------------------------------------------------

  const FONT = {
    A: ['..###..', '.##.##.', '##...##', '##...##', '#######', '##...##', '##...##'],
    B: ['######.', '##...##', '##...##', '######.', '##...##', '##...##', '######.'],
    C: ['.#####.', '##...##', '##.....', '##.....', '##.....', '##...##', '.#####.'],
    D: ['#####..', '##..##.', '##...##', '##...##', '##...##', '##..##.', '#####..'],
    E: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '#######'],
    F: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '##.....'],
    G: ['.#####.', '##.....', '##.....', '##..###', '##...##', '##...##', '.######'],
    H: ['##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##'],
    I: ['######.', '..##...', '..##...', '..##...', '..##...', '..##...', '######.'],
    J: ['..#####', '....##.', '....##.', '....##.', '##..##.', '##..##.', '.####..'],
    K: ['##...##', '##..##.', '##.##..', '####...', '#####..', '##..##.', '##...##'],
    L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######'],
    M: ['##...##', '###.###', '#######', '#######', '##.#.##', '##...##', '##...##'],
    N: ['##...##', '###..##', '####.##', '##.####', '##..###', '##...##', '##...##'],
    O: ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    P: ['######.', '##...##', '##...##', '######.', '##.....', '##.....', '##.....'],
    Q: ['.#####.', '##...##', '##...##', '##...##', '##.####', '##..##.', '.###.##'],
    R: ['######.', '##...##', '##...##', '######.', '##.##..', '##..##.', '##...##'],
    S: ['.#####.', '##...##', '##.....', '.#####.', '.....##', '##...##', '.#####.'],
    T: ['######.', '..##...', '..##...', '..##...', '..##...', '..##...', '..##...'],
    U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    V: ['##...##', '##...##', '##...##', '###.###', '.#####.', '..###..', '...#...'],
    W: ['##...##', '##...##', '##.#.##', '#######', '#######', '###.###', '##...##'],
    X: ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##'],
    Y: ['##..##.', '##..##.', '##..##.', '.####..', '..##...', '..##...', '..##...'],
    Z: ['#######', '....###', '...###.', '..###..', '.###...', '###....', '#######'],
    0: ['.####..', '##..##.', '##..##.', '##..##.', '##..##.', '##..##.', '.####..'],
    1: ['..##...', '.###...', '..##...', '..##...', '..##...', '..##...', '######.'],
    2: ['.#####.', '##...##', '.....##', '..####.', '.###...', '##.....', '#######'],
    3: ['#######', '....##.', '...##..', '..####.', '.....##', '##...##', '.#####.'],
    4: ['...###.', '..####.', '.##.##.', '##..##.', '#######', '....##.', '....##.'],
    5: ['######.', '##.....', '######.', '.....##', '.....##', '##...##', '.#####.'],
    6: ['..####.', '.##....', '##.....', '######.', '##...##', '##...##', '.#####.'],
    7: ['#######', '##...##', '....##.', '...##..', '..##...', '..##...', '..##...'],
    8: ['.#####.', '##...##', '##...##', '.#####.', '##...##', '##...##', '.#####.'],
    9: ['.#####.', '##...##', '##...##', '.######', '.....##', '....##.', '.####..'],
    '-': ['.......', '.......', '.......', '######.', '######.', '.......', '.......'],
    '!': ['..##...', '..##...', '..##...', '..##...', '..##...', '.......', '..##...'],
    '?': ['.#####.', '##...##', '....##.', '...##..', '..##...', '.......', '..##...'],
    '.': ['.......', '.......', '.......', '.......', '.......', '..##...', '..##...'],
    ',': ['.......', '.......', '.......', '.......', '..##...', '..##...', '.##....'],
    ':': ['.......', '..##...', '..##...', '.......', '..##...', '..##...', '.......'],
    "'": ['..##...', '..##...', '.##....', '.......', '.......', '.......', '.......'],
    '"': ['.##.##.', '.##.##.', '.#..#..', '.......', '.......', '.......', '.......'],
    '>': ['.##....', '..##...', '...##..', '....##.', '...##..', '..##...', '.##....'],
    '<': ['....##.', '...##..', '..##...', '.##....', '..##...', '...##..', '....##.'],
    '+': ['.......', '..##...', '..##...', '######.', '######.', '..##...', '..##...'],
    '/': ['.....##', '....##.', '...##..', '..##...', '.##....', '##.....', '.......'],
    '×': ['.......', '##...##', '.##.##.', '..###..', '.##.##.', '##...##', '.......'],
    '©': ['.#####.', '#.....#', '#.###.#', '#.#...#', '#.###.#', '#.....#', '.#####.'],
    '♥': ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
    '★': ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '##...##'],
    '✻': ['...#...', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '...#...'],
    '✓': ['......#', '.....##', '....##.', '#..##..', '##.##..', '.###...', '..#....'],
    '▶': ['##.....', '####...', '######.', '#######', '######.', '####...', '##.....'],
    ' ': ['.......', '.......', '.......', '.......', '.......', '.......', '.......'],
  };
  R.FONT = FONT;
  const GLYPH = 7; // ink size; each glyph sits in an 8 x 8 cell (1 blank column and row)
  const CELL = 8;
  R.CELL = CELL;
  const white = () => R.RETRO_PAL.hudWhite || NES[0x30];

  /** pxtextWidth(str, scale) : width of a pixel-text string in game px (8 per glyph, minus the last gap). */
  R.pxtextWidth = (str, scale = 1) => {
    const s = String(str).toUpperCase();
    return s.length ? (s.length * CELL - 1) * scale : 0;
  };
  R.PXTEXT_H = GLYPH; // glyph ink height in game px at scale 1

  /**
   * pxtext(ctx, str, gx, gy, o) : pixel text, top-left at game px (gx, gy).
   *   o.color (an NES hex, default RETRO_PAL.hudWhite or $30), o.scale (integer),
   *   o.align 'left'|'center'|'right', o.alpha,
   *   o.shadow (an NES hex: a 1-game-px drop shadow down-right, drawn first).
   *   Glyphs are 7x7 ink in 8x8 cells: advance 8 * scale, ink height 7 * scale.
   *   Returns the width in game px.
   */
  R.pxtext = (ctx, str, gx, gy, o = {}) => {
    const s = String(str).toUpperCase();
    const scale = o.scale || 1;
    let x = Math.round(gx);
    const y = Math.round(gy);
    const wdt = R.pxtextWidth(s, scale);
    if (o.align === 'center') x -= Math.floor(wdt / 2);
    else if (o.align === 'right') x -= wdt;
    // safe-area probe: the drawn box in FINAL canvas px (native px x the present scale FILM.canvas / native canvas)
    if (FILM.__textProbe && s.length) {
      const nat = ctx.canvas;
      const out = FILM.canvas || nat;
      const sx = nat && nat.width ? out.width / nat.width : 1;
      const sy = nat && nat.height ? out.height / nat.height : 1;
      const sh = o.shadow ? 1 : 0;
      FILM.__textProbe(String(str), x * PX * sx, y * PX * sy, (wdt + sh) * PX * sx, (GLYPH * scale + sh) * PX * sy);
    }
    ctx.save();
    if (o.alpha != null) ctx.globalAlpha *= o.alpha;
    const pass = (dx, dy, color) => {
      ctx.fillStyle = color;
      for (let i = 0; i < s.length; i++) {
        const gl = FONT[s[i]] || FONT[' '];
        const x0 = x + i * CELL * scale + dx;
        for (let r = 0; r < GLYPH; r++) {
          const row = gl[r];
          for (let c = 0; c < GLYPH; c++) {
            if (row[c] === '#') ctx.fillRect((x0 + c * scale) * PX, (y + dy + r * scale) * PX, scale * PX, scale * PX);
          }
        }
      }
    };
    if (o.shadow) pass(1, 1, o.shadow);
    pass(0, 0, o.color || white());
    ctx.restore();
    return wdt;
  };

  /**
   * hud(ctx, o) : a platformer status bar across the top 32 native px (320 wide), two text rows at
   * y 8 and y 16 (HUD_ROWS). o = { name, score, coins, world, time, frame, color, coin }.
   *   name (REQUIRED) over a 6-digit score at x 28; the blinking coin sprite (o.coin + 1..3, default
   *   'hudcoin', skipped when not drawn) at x 106 and "×NN" at x 114; "WORLD" at x 180 with the world
   *   centred under it; "TIME" at x 260 with the count right-aligned under it. time null or '' leaves
   *   the count blank. frame (global 60 Hz frame) drives the coin blink; default from FILM.lib.T.
   */
  R.HUD_ROWS = [8, 16];
  R.HUD_H = 32;
  R.hud = (ctx, o = {}) => {
    const nm = o.name != null ? o.name : o.label;
    if (nm == null || nm === '') throw new Error('FILM.retro.hud: o.name is required');
    const c = o.color || white();
    const name = String(nm);
    const score = String(Math.max(0, Math.round(o.score || 0))).padStart(6, '0');
    const coins = '×' + String(Math.max(0, Math.round(o.coins || 0))).padStart(2, '0');
    const world = o.world == null ? '1-1' : String(o.world);
    const time = o.time == null || o.time === '' ? '' : String(Math.max(0, Math.round(o.time))).padStart(3, '0');
    const f = o.frame != null ? o.frame : Math.floor(((FILM.lib && FILM.lib.T) || 0) * 60 + EPS);
    const [y0, y1] = R.HUD_ROWS;
    R.pxtext(ctx, name, 28, y0, { color: c });
    R.pxtext(ctx, score, 28, y1, { color: c });
    const coin = (o.coin || 'hudcoin') + (1 + R.shimmer(f));
    if (R.hasSprite(coin)) R.sprite(ctx, coin, 106, y1 - 1);
    R.pxtext(ctx, coins, 114, y1, { color: c });
    R.pxtext(ctx, 'WORLD', 180, y0, { color: c });
    R.pxtext(ctx, world, 180 + Math.floor((R.pxtextWidth('WORLD') - R.pxtextWidth(world)) / 2), y1, { color: c });
    R.pxtext(ctx, 'TIME', 260, y0, { color: c });
    if (time) R.pxtext(ctx, time, 260 + R.pxtextWidth('TIME') - R.pxtextWidth(time), y1, { color: c });
  };

  /**
   * titleBox(ctx, cx, y, o) : a title plaque: a panel inside a one-pixel border with chamfered
   * corners, an optional icon glyph at the left and the title in big letters beside it.
   * Centred on game x cx, top at y.
   *   o.text (REQUIRED), o.scale (2), o.pad (6), o.gap (6, icon to text), o.fill ($0F), o.border ($26),
   *   o.color (text, $30), o.icon (the icon colour; off unless set), o.iconGlyph ('★'),
   *   o.lines (extra scale-1 lines under the title, in o.subColor, $36).
   *   Returns { x, y, w, h } in game px.
   */
  R.titleBox = (ctx, cx, y, o = {}) => {
    if (o.text == null || o.text === '') throw new Error('FILM.retro.titleBox: o.text is required');
    const text = String(o.text);
    const scale = o.scale || 2;
    const pad = o.pad != null ? o.pad : 6;
    const gap = o.gap != null ? o.gap : 6;
    const lines = (o.lines || []).map(String);
    const icon = o.icon ? o.icon : null;
    const iconW = icon ? GLYPH * scale : 0;
    const textW = R.pxtextWidth(text, scale);
    const subW = lines.length ? Math.max.apply(null, lines.map((l) => R.pxtextWidth(l))) : 0;
    const innerW = Math.max(iconW + (icon ? gap : 0) + textW, subW);
    const w = innerW + 2 * pad + 2;
    const h = GLYPH * scale + lines.length * (CELL + 2) + (lines.length ? 3 : 0) + 2 * pad + 2;
    const x = Math.round(cx - w / 2);
    const Y = Math.round(y);
    const border = o.border || NES[0x26];
    // panel with chamfered corners, then the border line round it
    R.px(ctx, x + 2, Y, w - 4, h, o.fill || NES[0x0f]);
    R.px(ctx, x + 1, Y + 1, w - 2, h - 2, o.fill || NES[0x0f]);
    R.px(ctx, x, Y + 2, w, h - 4, o.fill || NES[0x0f]);
    R.px(ctx, x + 2, Y, w - 4, 1, border);
    R.px(ctx, x + 2, Y + h - 1, w - 4, 1, border);
    R.px(ctx, x, Y + 2, 1, h - 4, border);
    R.px(ctx, x + w - 1, Y + 2, 1, h - 4, border);
    for (const [dx, dy] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]]) R.px(ctx, x + dx, Y + dy, 1, 1, border);
    const tx = x + 1 + pad + Math.floor((innerW - (iconW + (icon ? gap : 0) + textW)) / 2);
    const ty = Y + 1 + pad;
    if (icon) R.pxtext(ctx, o.iconGlyph || '★', tx, ty, { scale, color: icon });
    R.pxtext(ctx, text, tx + (icon ? iconW + gap : 0), ty, { scale, color: o.color || NES[0x30] });
    lines.forEach((l, i) => R.pxtext(ctx, l, x + 1 + pad, ty + GLYPH * scale + 3 + i * (CELL + 2), { color: o.subColor || NES[0x36] }));
    return { x, y: Y, w, h };
  };

  // ===========================================================================
  // NES motion kit (FILM.nes)
  // ===========================================================================
  // The console redraws every frame (60 Hz) and moves everything in whole game pixels: a sprite
  // at 72 px/s steps 1 or 2 px a frame, never "on twos". Animation drawings hold for a fixed
  // number of frames, counted on the global frame index so a cycle runs on across cuts.
  const nes = {
    /** shot-local seconds -> frame index at the film's frame rate */
    frameOf: (t) => Math.floor(t * FILM.FPS + EPS),
    /** drawing index of an n-drawing cycle that holds each drawing `hold` frames */
    step: (frame, hold, n) => ((Math.floor(frame / hold) % n) + n) % n,
    /** frames each run-cycle drawing holds at a ground speed in game px/s (faster run, faster legs) */
    runHold: (speed) => (speed >= 120 ? 4 : speed >= 60 ? 5 : 6),
    /** constant-gravity arc: y at progress u in [0, 1] of a hop from y0 with apex h */
    arc: (y0, h, u) => y0 - 4 * h * u * (1 - u),
  };
  FILM.nes = Object.freeze(nes);

  // ===========================================================================
  // NES palette fade (a 'fade' into a mode 'none' shot of a retro film)
  // ===========================================================================
  // The console cannot blend two pictures: it fades by stepping every palette entry one
  // brightness row darker ($3x -> $2x -> $1x -> $0x -> black), so every frame of the fade is
  // still drawn in console colours. The outgoing shot steps down to black, the incoming one
  // steps up out of it.
  let nesCache = null;
  function nesTable() {
    if (nesCache) return nesCache;
    const rgb = NES.map((v) => parseInt(v.slice(1), 16));
    nesCache = { rgb, idx: new Map(), dark: new Map() };
    return nesCache;
  }
  // palette index of a colour: an exact match (brightest row first, so white steps down all four
  // rows), otherwise the nearest entry
  function nesNearest(tab, c) {
    let i = tab.idx.get(c);
    if (i !== undefined) return i;
    i = -1;
    for (let r = 3; r >= 0 && i < 0; r--) {
      for (let h = 0; h < 16; h++) {
        if (tab.rgb[r * 16 + h] === c) {
          i = r * 16 + h;
          break;
        }
      }
    }
    if (i < 0) {
      let best = Infinity;
      for (let j = 0; j < 64; j++) {
        const v = tab.rgb[j];
        const dr = (v >> 16) - (c >> 16), dg = ((v >> 8) & 255) - ((c >> 8) & 255), db = (v & 255) - (c & 255);
        const dist = dr * dr + dg * dg + db * db;
        if (dist < best) {
          best = dist;
          i = j;
        }
      }
    }
    tab.idx.set(c, i);
    return i;
  }
  function nesDarker(tab, c, d) {
    const key = c * 8 + d;
    let v = tab.dark.get(key);
    if (v !== undefined) return v;
    const i = nesNearest(tab, c);
    const row = (i >> 4) - d;
    const hue = i & 15;
    const j = i < 0 || row < 0 || hue >= 14 ? 0x0f : row * 16 + hue;
    v = tab.rgb[j];
    tab.dark.set(key, v);
    return v;
  }
  function darkenLayer(Lr, d) {
    const c = Lr.canvas;
    const g = Lr.ctx;
    const tab = nesTable();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (d >= 4) {
      g.fillStyle = NES[0x0f];
      g.fillRect(0, 0, c.width, c.height);
      g.restore();
      return;
    }
    g.restore();
    const img = g.getImageData(0, 0, c.width, c.height);
    const px = img.data;
    let last = -1;
    let out = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      if (v !== last) {
        last = v;
        out = nesDarker(tab, v, d);
      }
      px[i] = out >> 16;
      px[i + 1] = (out >> 8) & 255;
      px[i + 2] = out & 255;
      px[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  // Two offscreen layers the size of the output canvas (core's own layers are private).
  const layers = [];
  function layer(i, w, h) {
    let L = layers[i];
    if (!L || L.canvas.width !== w || L.canvas.height !== h) {
      const canvas = newCanvas(w, h);
      L = layers[i] = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
    }
    return L;
  }
  function resetCtx(ctx) {
    for (let i = 0; i < 64; i++) ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  // Draws one shot at global time T into ctx: core's FILM.drawShot when it exposes one, otherwise
  // the same steps (black clear, base transform, the scene's draw with its info; mode 'none' has no grain).
  function drawShot(ctx, shot, T, outgoing) {
    if (typeof FILM.drawShot === 'function') return FILM.drawShot(ctx, shot, T, outgoing);
    resetCtx(ctx);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const def = FILM.registry && FILM.registry[shot.id];
    let t = Math.max(0, T - shot.start);
    if (outgoing) t = Math.min(t, shot.dur);
    if (FILM.baseTransform) FILM.baseTransform(ctx);
    if (!def) {
      FILM.errors && FILM.errors.push({ T, shot: shot.id, message: `no scene registered for shot '${shot.id}'`, missing: true });
      resetCtx(ctx);
      return;
    }
    const info = {
      dur: shot.dur,
      p: shot.dur > 0 ? Math.max(0, Math.min(1, t / shot.dur)) : 0,
      T,
      frame: Math.floor(T * FILM.FPS + EPS),
      W: FILM.W,
      H: FILM.H,
      S: FILM.S,
      lib: FILM.lib,
      shot,
      mode: FILM.modeOf ? FILM.modeOf(shot) : 'none',
      outgoing: !!outgoing,
    };
    try {
      ctx.save();
      def.draw(ctx, t, info);
    } catch (e) {
      FILM.errors && FILM.errors.push({ T, shot: shot.id, message: String((e && e.message) || e), stack: e && e.stack });
      if (FILM.strict) throw e;
    }
    resetCtx(ctx);
  }
  // k: frame position inside the transition (0 .. n). The first half steps the outgoing shot
  // down (1, 2, 3 rows darker, then black), the second half steps the incoming one up.
  function nesFade(ctx, prev, shot, T, k, n) {
    const half = n / 2;
    const out = k < half;
    const d = out ? Math.min(4, 1 + Math.floor((k / half) * 4)) : Math.max(1, 4 - Math.floor(((k - half) / half) * 4));
    const Lr = layer(out ? 0 : 1, ctx.canvas.width, ctx.canvas.height);
    drawShot(Lr.ctx, out ? prev : shot, T, out);
    darkenLayer(Lr, d);
    resetCtx(ctx);
    ctx.drawImage(Lr.canvas, 0, 0);
  }
  FILM.transitions = FILM.transitions || {};
  /** transitions.fade : the NES palette fade for a retro film going into a mode 'none' shot; false = core's fade. */
  FILM.transitions.fade = function (ctx, prev, shot, T, k, n) {
    if (!(FILM.TIMELINE && FILM.TIMELINE.retro)) return false;
    const mode = FILM.modeOf ? FILM.modeOf(shot) : String((shot && shot.mode) || '').toLowerCase();
    if (mode !== 'none') return false;
    nesFade(ctx, prev, shot, T, Math.floor(k + EPS), n);
    return true;
  };
})();
