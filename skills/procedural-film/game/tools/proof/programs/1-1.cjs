// tools/proof/programs/1-1.cjs : level 1-1, start to beacon. Two lines of play (routes.cjs): the overland
// line with the deck and stair-gap tokens (the attract tape), and the cellar line with the cellar token.
'use strict';
const routes = require('./routes.cjs');
const tokensAre = (want) => (W, events, GAME) => {
  const got = [0, 1, 2].filter((n) => ((W.tokens['1-1'] | 0) >> n) & 1);
  return [[JSON.stringify(got) === JSON.stringify(want), `tokens ${JSON.stringify(want)} of 1-1 (${JSON.stringify(got)})`]];
};
module.exports = [
  {
    name: '1-1',
    order: 1,
    what: 'level 1-1 from its start to the beacon, overland, with the deck and stair-gap tokens',
    opts: { start: '1-1' },
    exit: ['flagpole'],
    build: (k) => [k.mode('play'), ...routes.r11(k, { tokens: true })],
    check: tokensAre([0, 1]),
  },
  {
    name: '1-1-cellar',
    order: 2,
    what: 'level 1-1 from its start to the beacon by way of the cellar, with the cellar token',
    opts: { start: '1-1' },
    exit: ['flagpole'],
    build: (k) => [k.mode('play'), ...routes.r11b(k)],
    check: tokensAre([2]),
  },
];
