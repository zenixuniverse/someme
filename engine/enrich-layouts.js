// Layout enrichment — for formats where the classic top/bottom text placement is WRONG
// (quadrant formats like Gru's Plan, row formats like Drake/Expanding Brain, label formats
// like Two Buttons), ask Claude for percent-rect box layouts. Classic formats stay null.
// Usage: node engine/enrich-layouts.js
const fs = require('fs');
const path = require('path');
const { askClaude, extractJSON } = require('./claude.js');

const INDEX = path.join(__dirname, '..', 'templates', 'index.json');

async function main() {
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const need = index.templates.filter((t) => t.type === 'image' && !t.boxes && (t.box_count || 0) >= 2);
  console.log(`checking layouts for ${need.length} templates…`);

  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const listing = chunk.map((t) => `- id:"${t.id}" name:"${t.name}" size:${t.width}x${t.height} boxes:${t.box_count}${t.box_semantics ? ' semantics:[' + t.box_semantics.join(' | ') + ']' : ''}`).join('\n');
    const prompt = `You know the visual layout of famous meme templates. For each template below, decide where its text conventionally goes.

Return STRICT JSON keyed by id:
- If the format is a CLASSIC top/bottom overlay meme (text over the image top and bottom), return null.
- Otherwise return {"boxes":[{"x":<pct>,"y":<pct>,"w":<pct>,"h":<pct>}, …]} — one rect per text box IN THE SAME ORDER as the semantics, coordinates as PERCENT of image width/height (x,y = top-left of the text area). Examples of non-classic conventions:
  * Drake-style 2-row: text fills the RIGHT half of each row (x~52,w~45, one per row)
  * 4-panel Gru's Plan: text on the presentation board area of each panel
  * Expanding-brain N-row: text in the LEFT half of each row (image right)
  * Two Buttons: small rects on each button + optional bottom
  * Distracted Boyfriend: small label rects near each person
Be precise about which half/quadrant the text belongs in for the format's actual convention.

Templates:
${listing}

ONLY the JSON.`;
    try {
      const out = await askClaude(prompt, { timeoutMs: 300000 });
      const data = extractJSON(out);
      let set = 0;
      for (const t of chunk) {
        const e = data[t.id];
        if (e && Array.isArray(e.boxes) && e.boxes.length) {
          const ok = e.boxes.every((b) => [b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && n >= 0 && n <= 100));
          if (ok) { t.boxes = e.boxes; set++; }
        }
      }
      fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
      console.log(`  chunk ${1 + i / 20}: ${set}/${chunk.length} got custom layouts`);
    } catch (e) { console.log(`  chunk ${1 + i / 20} FAILED: ${e.message}`); }
  }
  const custom = index.templates.filter((t) => t.boxes).length;
  console.log('RESULT:' + JSON.stringify({ custom_layouts: custom }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
