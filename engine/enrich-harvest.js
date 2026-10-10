// Regenerate harvested-library descriptions in SoMeme's OWN voice.
// We do NOT ship the vendor's AI text. For each template we hand Claude the name +
// their factual scene description as REFERENCE ONLY, and ask for fresh output framed
// for OUR use (what the format means + when to reach for it — which is also what makes
// the template-picking engine work), plus our own tags and an example caption set.
// Batched, resumable (skips desc_source:"someme"), atomic writes so the live server
// never reads a half-written index.
//   node engine/enrich-harvest.js            (rewrite all vendor-flagged)
//   node engine/enrich-harvest.js --limit 300
//   node engine/enrich-harvest.js --videos-only | --images-only
const fs = require('fs');
const path = require('path');
const { askClaude, extractJSON } = require('./claude.js');

const INDEX = path.join(__dirname, '..', 'templates', 'index.json');
const CHUNK = 30;

function writeAtomic(obj) {
  // temp MUST live on the same volume as INDEX or rename() throws EXDEV (cross-device)
  const tmp = INDEX + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, INDEX); // atomic same-volume swap → server never reads a partial file
}

async function main() {
  const args = process.argv.slice(2);
  const limIx = args.indexOf('--limit');
  const limit = limIx >= 0 ? parseInt(args[limIx + 1], 10) : Infinity;
  const videosOnly = args.includes('--videos-only');
  const imagesOnly = args.includes('--images-only');

  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  let todo = index.templates.filter((t) => t.desc_source === 'vendor');
  if (videosOnly) todo = todo.filter((t) => t.type === 'video');
  if (imagesOnly) todo = todo.filter((t) => t.type !== 'video');
  todo = todo.slice(0, limit);
  console.log(`rewriting ${todo.length} descriptions in SoMeme's voice (chunks of ${CHUNK})…`);

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const listing = chunk.map((t) =>
      `- id:"${t.id}" | name:"${t.name}" | type:${t.type} | boxes:${t.box_count} | reference:"${String(t.description || '').replace(/\s+/g, ' ').slice(0, 220)}"`
    ).join('\n');
    const prompt = `You are the meme-template librarian for SoMeme, a meme-marketing tool. For each template, write ORIGINAL metadata in SoMeme's voice — dry, sharp, useful, no fluff. The "reference" is a plain description of the image FOR YOUR UNDERSTANDING ONLY; do NOT copy its wording — write your own, and frame it around what the format MEANS and when a marketer would reach for it (this is what an LLM uses to pick the right template).

Return STRICT JSON keyed by id, each value:
{"description":"<1-2 sentences: what the format is + what it's used to express. Topic-matching oriented, SoMeme voice. Never reuse the reference's phrasing.>",
 "tags":["<5-8 lowercase tags: emotions, situations, use-cases>"],
 "example_captions":["<one caption per text box (match the box count shown per template), forming ONE coherent, funny business/marketing example>"]}

For video templates, example_captions is a single-element array (one caption).

Templates:
${listing}

Return ONLY the JSON object.`;

    try {
      const out = await askClaude(prompt, { timeoutMs: 240000 });
      const data = extractJSON(out);
      let hit = 0;
      for (const t of chunk) {
        const e = data[t.id];
        if (!e || !e.description) continue;
        t.description = e.description;
        if (Array.isArray(e.tags) && e.tags.length) t.tags = e.tags.slice(0, 12);
        if (Array.isArray(e.example_captions) && e.example_captions.length) t.example_captions = e.example_captions;
        t.desc_source = 'someme';
        hit++; done++;
      }
      writeAtomic(index); // incremental + atomic → resumable, and server never sees a partial file
      console.log(`  chunk ${1 + i / CHUNK}/${Math.ceil(todo.length / CHUNK)}: ${hit}/${chunk.length} rewritten (total ${done})`);
    } catch (e) {
      failed += chunk.length;
      console.log(`  chunk ${1 + i / CHUNK} FAILED: ${e.message} — leaving as vendor, will retry on next run`);
    }
  }

  const remaining = index.templates.filter((t) => t.desc_source === 'vendor').length;
  console.log(`RESULT:${JSON.stringify({ rewritten: done, failed, remaining_vendor: remaining })}`);
}

main().catch((e) => { console.error('ENRICH ERROR: ' + (e.stack || e)); process.exitCode = 1; });
