// tools/proof/levels.data.cjs : the per-level data tools/levels-lint.cjs checks, keyed by level id.
// Owner: the level author. Every key is optional; a level with no entry here still gets every generic rule
// (rows, characters, F3, F4, F6, F7, F8, the pit rule, pipes, routing, checkpoint, tokens).
//
//   'id': {
//     jumps: [                                   F1, F2: every jump the level requires (or offers)
//       { name, from: [firstCol, lastCol, row, 'lift'?], to: [firstCol, lastCol, row, 'lift'?],
//         kind: 'req' | 'opt', small?: true, big?: true },
//     ],                                         from/to: the standing surface (top y = row * 16 - 12);
//                                                'lift': that end is a lift, frozen there as a solid row;
//                                                'req' is judged at walk speed, 'opt' (a secret, a token,
//                                                the finale) at run speed.
//     changes: [                                 map cells that differ from the level's design sketch,
//       { row, col, from, to, rule, why },       each with the rule it keeps; the lint checks `to` is in
//     ],                                         the map and prints the reason
//     defChanges: [                              definition changes (not cells), each with a test
//       { what, rule, why, test: (DEFS) => boolean },
//     ],
//     routes: {                                  F5: how each token and each N + C block is reached, and
//       token: { 0: ['where and how', 'program'] },       the saved program that proves it
//       block: { 'col:row': ['what', 'program'] },         (tools/proof/tapes/<program>.{nes,modern}.json)
//     },
//   },
//
// Example (one required jump over a 3-tile pit on the floor row):
//   '1-1': { jumps: [{ name: 'the pit at 27-29', from: [21, 26, 10], to: [30, 35, 10], kind: 'req' }] },
'use strict';

module.exports = {
  '1-1': {
    jumps: [
      { name: 'onto the down pipe at 46 (3 tiles up)', from: [42, 45, 10], to: [46, 47, 7], kind: 'req' },
      { name: 'the first pit at 58-60', from: [50, 57, 10], to: [61, 65, 10], kind: 'req' },
      { name: 'the gap between the twin stairs at 108-109', from: [107, 107, 6], to: [110, 110, 6], kind: 'req' },
      { name: 'the second pit at 131-133', from: [128, 130, 10], to: [134, 139, 10], kind: 'req' },
    ],
    routes: {
      token: {
        0: ['over the brick deck at 72-79: jump from the deck', '1-1'],
        1: ['over the stair gap at 108: jump from the top step', '1-1'],
        2: ['the cellar (1-1b), over the right pillar', '1-1-cellar'],
      },
    },
  },
};
