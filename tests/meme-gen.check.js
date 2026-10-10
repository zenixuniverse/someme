// node tests/meme-gen.check.js — no server, no Claude calls (stubbed).
const assert = require('assert');
const { isUnsafe, tinyBoxes, wantsVideo, catalogSlice, fixBoxCounts } = require('../engine/meme-gen.js');

assert(isUnsafe({ name: 'ishowspeed jerking off' }));
assert(isUnsafe({ name: 'Suicide Adapter' }));
assert(isUnsafe({ name: 'Concerned Doge Holding Gun' }));
assert(!isUnsafe({ name: 'Drake Hotline Bling', tags: ['preference'] }));
assert(!isUnsafe({ name: 'Gundam pose' }), 'gun must be a whole word');
assert(isUnsafe({ name: 'Sections of the Joint' }));
assert(tinyBoxes({ boxes: [{ x: 2, y: 90, w: 15.8, h: 3.7 }] }) && !tinyBoxes({ boxes: [{ x: 52, y: 4, w: 45, h: 42 }] }) && !tinyBoxes({ boxes: null }));
assert(tinyBoxes({ boxes: [{ x: 6.9, y: 39, w: 40, h: 18 }, { x: 23.6, y: 40.9, w: 40, h: 19.5 }] }), 'overlapping boxes');
assert(tinyBoxes({ boxes: [{ x: 87.6, y: 30, w: 40, h: 20 }] }), 'box off the image');
assert(!tinyBoxes({ boxes: [{ x: 1, y: 2, w: 48, h: 20 }, { x: 51, y: 2, w: 48, h: 20 }] }), 'side-by-side is fine');
assert(wantsVideo('turn it into a video meme') && !wantsVideo('stages of an instagram plateau'));

const index = { templates: [
  { id: 'a', name: 'Drake', box_count: 2 },
  { id: 'v', name: 'Sonic alone', type: 'video', box_count: 0 },
  { id: 'x', name: 'you are an inanimate fucking object', type: 'video' },
  { id: 'm', name: 'Monkey Puppet', box_count: 2 },
  { id: 'yt', name: 'Blank YouTube Video', box_count: 1, boxes: [{ x: 2, y: 90, w: 15, h: 3 }] },
] };
const cat = catalogSlice(index, {});
assert(!cat.includes('id:"yt"') && cat.includes('id:"a"') && !cat.includes('id:"v"') && !cat.includes('id:"x"'));
assert(catalogSlice(index, { allowVideo: true }).includes('id:"v"'));
assert(!catalogSlice(index, { allowVideo: true }).includes('id:"x"'), 'unsafe video stays out');

(async () => {
  // repair call fails → overflow folded into the last box
  const p1 = await fixBoxCounts({ memes: [{ template_id: 'm', texts: ['1', '2', '3', '4', '5'] }] }, index, async () => { throw new Error('offline'); });
  assert.deepStrictEqual(p1.memes[0].texts, ['1', '2 3 4 5']);
  // repair call succeeds → its rewrite is used
  const p2 = await fixBoxCounts({ memes: [{ template_id: 'm', texts: ['1', '2', '3'] }] }, index, async () => '{"texts":[["short a","short b"]]}');
  assert.deepStrictEqual(p2.memes[0].texts, ['short a', 'short b']);
  // within limits → untouched, no call made
  const p3 = await fixBoxCounts({ memes: [{ template_id: 'a', texts: ['x', 'y'] }] }, index, async () => { throw new Error('should not be called'); });
  assert.deepStrictEqual(p3.memes[0].texts, ['x', 'y']);
  console.log('meme-gen checks: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
