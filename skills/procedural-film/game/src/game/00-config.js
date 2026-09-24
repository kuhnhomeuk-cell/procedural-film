// game/00-config.js : the one place a game names itself. Every other file reads its title, slug,
// hero, save key, legal line, level order and deploy target from GAME.CONFIG. Owner: game.
//
//   saveKey  must be '<slug>.save.v1'.
//   legal    empty by default. When non-empty it is shown in the menu help rows, in og:description and
//            on the share card. Use it when the game borrows a third party's character, logo or brand name.
//   order    the level ids in play order; firstLevel is where NEW GAME starts.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});
  GAME.CONFIG = Object.freeze({
    title: 'ROBOT RUN',
    slug: 'robot-run',
    heroName: 'BIT',
    saveKey: 'robot-run.save.v1',
    legal: '',
    description: 'An NES-style platformer. Play it in your browser.',
    order: Object.freeze(['1-1']),
    firstLevel: '1-1',
    siteUrl: '',
    vercelProject: '',
  });
})();
