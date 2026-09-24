// tools/proof/fixtures/engine-defs.cjs : the fixture levels tools/proof/engine-scenarios.cjs plays
// (EN1 to EN14). Owner: game. Small, purpose-built maps in the GAME_DEFS schema (docs/game-spec.md 4.3),
// ids prefixed 'en-' so they never collide with World 1. Every map is 12 rows of equal width; row r
// has its top at 16r - 12, the ground rows 10 and 11 fill y 148 to 180.
'use strict';

// a blank map w wide with ground ('#' or another char) in rows 10-11
function blank(w, ground = '#') {
  const rows = [];
  for (let r = 0; r < 12; r++) rows.push(new Array(w).fill(r >= 10 ? ground : '.'));
  return rows;
}
// write str into row r from column c
function put(rows, c, r, str) {
  for (let i = 0; i < str.length; i++) rows[r][c + i] = str[i];
  return rows;
}
// clear rows 10-11 from column c for n columns (a pit)
function pit(rows, c, n) {
  for (let i = 0; i < n; i++) rows[10][c + i] = rows[11][c + i] = '.';
  return rows;
}
const done = (rows) => rows.map((r) => r.join(''));

// the coin room's profile: walls, a ceiling gap at cols 1-2, the side pipe's mouth at col 15 (rows 8-9)
function room(extra) {
  const rows = [
    '....................',
    '....................',
    '....................',
    'W..WWWWWWWWWWWWWW{}W',
    'W................{}W',
    'W................{}W',
    'W................{}W',
    'W................{}W',
    'W..............h-j}W',
    'W..............H_J}W',
    'GGGGGGGGGGGGGGGGGGGG',
    'GGGGGGGGGGGGGGGGGGGG',
  ].map((r) => r.split(''));
  if (extra) extra(rows);
  return done(rows);
}

// en-a: the checkpoint level. Start x 64; checkpoint at col 12; a bug behind the start (col 1, it walks
// away) and two ahead (cols 22 and 24) that meet him past the checkpoint; a pit at 44-46; the pole at 60.
const A = blank(72);
put(A, 1, 9, 'g');
put(A, 22, 9, 'g');
put(A, 24, 9, 'g');
pit(A, 44, 3);
put(A, 60, 3, '!');
for (let r = 4; r <= 8; r++) put(A, 60, r, '|');
put(A, 60, 9, 'X');

// en-flat: open ground, a ledge at col 20 (pit 20-24, ground again from 25), for coyote and the buffer
const FLAT = blank(64);
pit(FLAT, 20, 5);

// en-corner: blocks in row 6 for head grazes: B at 10, + at 30, B at 40
const CORNER = blank(56);
put(CORNER, 10, 6, 'B');
put(CORNER, 30, 6, '+');
put(CORNER, 40, 6, 'B');

// en-blocks: row 7 blocks: C at 10 and 20 (multi-coin), N at 30 (1UP), + at 40 (hidden 1UP), M at 50
const BLOCKS = blank(72);
put(BLOCKS, 10, 7, 'C');
put(BLOCKS, 20, 7, 'C');
put(BLOCKS, 30, 7, 'N');
put(BLOCKS, 40, 7, '+');
put(BLOCKS, 50, 7, 'M');

// en-hit: a bug ahead at col 12
const HIT = blank(40);
put(HIT, 12, 9, 'g');

// en-pit: a pit right ahead of the start (cols 6-8)
const PIT = blank(40);
pit(PIT, 6, 3);

// en-r1: over main level, pipe down at 10 (to en-r1b), pipe up at 30, checkpoint 20
const R1 = blank(60);
put(R1, 10, 8, '[]');
put(R1, 10, 9, '{}');
put(R1, 30, 8, '[]');
put(R1, 30, 9, '{}');

// en-r2: under main level: pipe down at 10 (to en-r2b), pipe up at 20, side pipe at 40 (to en-r2x)
const R2 = blank(60, 'G');
put(R2, 10, 8, '[]');
put(R2, 10, 9, '{}');
put(R2, 20, 8, '[]');
put(R2, 20, 9, '{}');
put(R2, 40, 8, 'h-j}');
put(R2, 40, 9, 'H_J}');
for (let r = 3; r <= 7; r++) put(R2, 42, r, '{}');

// en-r2x: the exit yard, rising from the pipe at 2, the pole at 20
const R2X = blank(32);
put(R2X, 2, 8, '[]');
put(R2X, 2, 9, '{}');
put(R2X, 20, 3, '!');
for (let r = 4; r <= 8; r++) put(R2X, 20, r, '|');
put(R2X, 20, 9, 'X');

// en-e1: a short run to the pole (col 16), the goal house at 22; next en-e2
const E1 = blank(40);
put(E1, 16, 3, '!');
for (let r = 4; r <= 8; r++) put(E1, 16, r, '|');
put(E1, 16, 9, 'X');

// en-e2: the last level (no next): the same run to the pole, with a pit behind the start (cols 0-1)
const E2 = blank(40);
pit(E2, 0, 2);
put(E2, 16, 3, '!');
for (let r = 4; r <= 8; r++) put(E2, 16, r, '|');
put(E2, 16, 9, 'X');

const DEFS = {
  'en-a': { id: 'en-a', name: 'CHECKPOINT', world: '8-1', kind: 'over', rows: done(A), time: 400, song: 'overworld',
    start: { x: 64, y: 148 }, mid: { tx: 12, row: 10 }, pole: 60, castle: 66, next: 'en-flat' },
  'en-flat': { id: 'en-flat', name: 'FLAT', world: '8-2', kind: 'over', rows: done(FLAT), time: 400, song: 'overworld',
    start: { x: 40, y: 148 } },
  'en-corner': { id: 'en-corner', name: 'CORNERS', world: '8-3', kind: 'over', rows: done(CORNER), time: 400, song: 'overworld',
    start: { x: 40, y: 148 } },
  'en-blocks': { id: 'en-blocks', name: 'BLOCKS', world: '8-4', kind: 'over', rows: done(BLOCKS), time: 400, song: 'overworld',
    start: { x: 40, y: 148 } },
  'en-under': { id: 'en-under', name: 'UNDER', world: '8-4', kind: 'under', rows: done(blank(40, 'G')), time: 400, song: 'underground',
    start: { x: 40, y: 148 } },
  'en-hit': { id: 'en-hit', name: 'HIT', world: '8-6', kind: 'over', rows: done(HIT), time: 400, song: 'overworld',
    start: { x: 40, y: 148 } },
  'en-pit': { id: 'en-pit', name: 'PIT', world: '8-7', kind: 'over', rows: done(PIT), time: 400, song: 'overworld',
    start: { x: 40, y: 148 } },
  'en-r1': { id: 'en-r1', name: 'ROUTE ONE', world: '8-8', kind: 'over', rows: done(R1), time: 400, song: 'overworld',
    start: { x: 40, y: 148 }, mid: { tx: 20, row: 10 }, pipeDown: { tx: 10, to: 'en-r1b' }, pipeUp: { tx: 30 } },
  'en-r1b': { id: 'en-r1b', name: 'ROUTE ONE', world: '8-8', kind: 'under', rows: room(), time: 0, song: 'underground',
    main: 'en-r1', respawn: 'en-r1', start: { x: 20, y: 36, drop: true }, pipeSide: { tx: 15, row: 8, to: 'en-r1', at: 'pipeUp' } },
  'en-r2': { id: 'en-r2', name: 'ROUTE TWO', world: '8-9', kind: 'under', rows: done(R2), time: 400, song: 'underground',
    start: { x: 40, y: 148 }, pipeDown: { tx: 10, to: 'en-r2b' }, pipeUp: { tx: 20 },
    pipeSide: { tx: 40, row: 8, to: 'en-r2x', at: 'pipeUp' } },
  'en-r2b': { id: 'en-r2b', name: 'ROUTE TWO', world: '8-9', kind: 'under', rows: room((r) => (r[9][12] = 'g')), time: 0,
    song: 'underground', main: 'en-r2', respawn: 'en-r2', start: { x: 20, y: 36, drop: true },
    pipeSide: { tx: 15, row: 8, to: 'en-r2', at: 'pipeUp' } },
  'en-r2x': { id: 'en-r2x', name: 'ROUTE TWO', world: '8-9', kind: 'over', rows: done(R2X), time: 0, song: 'overworld',
    main: 'en-r2', respawn: 'en-r2', next: 'en-flat', pipeUp: { tx: 2 }, pole: 20, castle: 26, start: { x: 40, y: 148 } },
  'en-e1': { id: 'en-e1', name: 'THE RUN', world: '9-1', kind: 'over', rows: done(E1), time: 400, song: 'overworld',
    start: { x: 40, y: 148 }, pole: 16, castle: 22, next: 'en-e2' },
  'en-e2': { id: 'en-e2', name: 'THE END', world: '9-2', kind: 'over', rows: done(E2), time: 300, song: 'overworld',
    start: { x: 40, y: 148 }, pole: 16, castle: 22 },
};

module.exports = { DEFS, blank, put, pit, done };
