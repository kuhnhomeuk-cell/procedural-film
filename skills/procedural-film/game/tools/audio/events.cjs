// events.cjs : what the sound driver will be fed. Prints the event source, counts per type, the song
// timeline and any event type music.js has no sound for; writes the list to .tmp/audio/events.json.
//   node tools/audio/events.cjs [--mock]
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./host.cjs');
(async () => {
  const { events, source } = await H.events({ mock: process.argv.includes('--mock') });
  fs.mkdirSync(H.OUT, { recursive: true });
  fs.writeFileSync(path.join(H.OUT, 'events.json'), JSON.stringify(events, null, 0));
  const FILM = H.load({ foley: false });
  const known = new Set(FILM.audio.sfx);
  const songs = new Set(FILM.audio.songs.concat(['none']));
  const count = {};
  for (const e of events) count[e.type] = (count[e.type] || 0) + 1;
  console.log(`source: ${source}; ${events.length} events, frames ${events.length ? events[0].f : '-'}..${events.length ? events[events.length - 1].f : '-'}`);
  console.log('per type: ' + Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('songs: ' + events.filter((e) => e.type === 'song').map((e) => `f${e.f} ${e.id}`).join(' | '));
  const odd = events.filter((e) => (e.type === 'song' ? !songs.has(e.id) : !known.has(e.type)));
  console.log(odd.length ? `NOT HANDLED: ${odd.map((e) => `f${e.f} ${e.type} ${e.id || ''}`).join(', ')}` : 'every event has a sound (or is a known song id)');
  const unsorted = events.some((e, i) => i && e.f < events[i - 1].f);
  if (unsorted) console.log('WARNING: events are not sorted by f');
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
