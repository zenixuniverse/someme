// SoMeme trend scout — replaces Memelord's editorial trending feed with an automated sweep.
// claude -p with WebSearch/WebFetch (explicit budget) → templates/trending.json + event log for
// "new-trend"-triggered missions. Honest gap vs the vendor: we refresh on schedule, not live.
// Usage: node engine/trend-scout.js
const fs = require('fs');
const path = require('path');
const { askClaude, extractJSON } = require('./claude.js');

const TPL_DIR = path.join(__dirname, '..', 'templates');
const TR_IMG = path.join(TPL_DIR, 'trending-img');

async function main() {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(TPL_DIR, 'trending.json'), 'utf8')); } catch { return { items: [] }; } })();
  const prevNames = prev.items.map((i) => i.name).join('; ');

  const prompt = `You are a meme trend scout for marketers. Find what meme formats/templates are trending RIGHT NOW (today).
Budget: use AT MOST 6 web operations total (searches + fetches), then answer. Good sources: knowyourmeme.com/memes/trending, reddit r/memes top today, r/MemeTemplatesOfficial hot, X viral formats coverage.
Previously seen (deprioritize unless still peaking): ${prevNames || 'none'}

Return STRICT JSON:
{"items":[{"name":"<template/format name>",
  "why_trending":"<one line: where it came from / what it expresses>",
  "heat":1-3,
  "age":"<e.g. '2d', '1w'>",
  "source_url":"<link to the format writeup or post>",
  "image_url":"<direct image URL of the template if you found one, else null>",
  "suggested_angles":["<brand-marketing angle 1>","<angle 2>"]}]}
8-14 items, hottest first. ONLY the JSON.`;

  console.log('scouting trends (claude + web, max 6 ops)…');
  const out = await askClaude(prompt, { allowedTools: 'WebSearch,WebFetch', timeoutMs: 420000 });
  const data = extractJSON(out);
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('scout returned no items');

  // best-effort local preview downloads (never hotlink at render time)
  fs.mkdirSync(TR_IMG, { recursive: true });
  for (const it of data.items) {
    it.id = 'tr-' + it.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    if (it.image_url) {
      try {
        const r = await fetch(it.image_url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image')) {
          const ext = (r.headers.get('content-type').split('/')[1] || 'jpg').split(';')[0];
          const f = it.id + '.' + ext;
          fs.writeFileSync(path.join(TR_IMG, f), Buffer.from(await r.arrayBuffer()));
          it.preview = '/templates/trending-img/' + f;
        }
      } catch { /* preview optional */ }
    }
    delete it.image_url;
  }

  const now = new Date().toISOString();
  const newNames = data.items.filter((i) => !prev.items.some((p) => p.name.toLowerCase() === i.name.toLowerCase())).map((i) => i.name);
  fs.writeFileSync(path.join(TPL_DIR, 'trending.json'), JSON.stringify({ updated: now, items: data.items }, null, 2));
  fs.appendFileSync(path.join(TPL_DIR, 'trend-events.log'), `${now} new=${newNames.length} ${newNames.join(' | ')}\n`);
  if (newNames.length) require('./toast.js').toast('SoMeme — meme alert', newNames.length + ' new trending format' + (newNames.length > 1 ? 's' : '') + ': ' + newNames.slice(0, 3).join(', '));
  console.log(`feed updated: ${data.items.length} items, ${newNames.length} new (${newNames.join(', ') || '—'})`);
  console.log('RESULT:' + JSON.stringify({ items: data.items.length, new: newNames.length, updated: now }));
}

main().catch((e) => { console.error('SCOUT ERROR: ' + (e.stack || e)); process.exitCode = 1; });
