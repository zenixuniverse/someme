// SoMeme render engine — sharp + SVG text. Two modes, mirroring the captured data model:
//   template mode: positioned text boxes over the template image (classic Impact look)
//   caption mode: "top" (white letterbox bar), "tiktok" (centered pill overlay), "snapchat" (lower-third strip)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const FONT_STACK = "Impact, 'Arial Black', 'Segoe UI', sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Greedy wrap by estimated glyph width (Impact ≈ 0.50 em average; padded for safety).
function wrapText(text, fontSize, maxWidth) {
  const em = fontSize * 0.54;
  const perLine = Math.max(4, Math.floor(maxWidth / em));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (cand.length <= perLine) cur = cand;
    else {
      if (cur) lines.push(cur);
      if (w.length > perLine) { // hard-break very long words
        for (let i = 0; i < w.length; i += perLine) lines.push(w.slice(i, i + perLine));
        cur = lines.pop();
      } else cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// Shrink font until the wrapped block fits the box — including the LONGEST WORD
// fitting on one line, or wrapText hard-breaks it mid-word ("IMPRESSION / S").
function fitText(text, boxW, boxH, startSize, minSize = 12) {
  const longest = Math.max(1, ...String(text).split(/\s+/).map((w) => w.length));
  let size = startSize;
  while (size > minSize) {
    const perLine = Math.max(4, Math.floor(boxW / (size * 0.54)));
    const lines = wrapText(text, size, boxW);
    const height = lines.length * size * 1.12;
    if (height <= boxH && longest <= perLine) return { size, lines };
    size -= 2;
  }
  return { size: minSize, lines: wrapText(text, minSize, boxW) };
}

const CLEAN_STACK = "'Segoe UI', Arial, sans-serif";
function textBlockSVG({ lines, size, cx, topY, fill = '#fff', stroke = '#000', uppercase = true, weight = 700, font = 'impact', anchor = 'middle' }) {
  const strokeW = stroke ? Math.max(2, Math.round(size / 14)) : 0;
  const fam = font === 'clean' ? CLEAN_STACK : FONT_STACK;
  const strokeAttrs = stroke ? ` stroke="${stroke}" stroke-width="${strokeW}" paint-order="stroke" stroke-linejoin="round"` : '';
  return lines.map((ln, i) => {
    const y = topY + (i + 0.85) * size * 1.12;
    const t = esc(uppercase ? ln.toUpperCase() : ln);
    return `<text x="${cx}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${strokeAttrs} fill="${fill}">${t}</text>`;
  }).join('\n');
}

// --- template mode -------------------------------------------------------
// boxes: [{text, x, y, w, h}] in PERCENT of image (defaults: classic top/bottom stack)
function defaultBoxes(count) {
  if (count <= 1) return [{ x: 5, y: 72, w: 90, h: 24 }];
  if (count === 2) return [{ x: 5, y: 3, w: 90, h: 22 }, { x: 5, y: 75, w: 90, h: 22 }];
  const boxes = [];
  for (let i = 0; i < count; i++) boxes.push({ x: 5, y: 3 + (94 / count) * i, w: 90, h: 94 / count - 4 });
  return boxes;
}

async function renderTemplateMode({ imgPath, boxes, outPath }) {
  const meta = await sharp(imgPath).metadata();
  const W = meta.width, H = meta.height;
  let svgParts = [];
  for (const b of boxes) {
    if (!b.text || !String(b.text).trim()) continue;
    const bx = (b.x / 100) * W, by = (b.y / 100) * H, bw = (b.w / 100) * W, bh = (b.h / 100) * H;
    if (![bx, by, bw, bh].every(Number.isFinite)) { console.log('WARN: text box missing geometry, skipped: ' + JSON.stringify(b).slice(0, 120)); continue; }
    const start = b.size ? Math.round((b.size / 100) * W) : Math.max(20, Math.round(W / 9));
    const { size, lines } = b.size
      ? { size: start, lines: wrapText(b.text, start, bw) }   // explicit size: wrap only, no shrink
      : fitText(b.text, bw, bh, start);
    const align = b.align === 'left' ? 'start' : b.align === 'right' ? 'end' : 'middle';
    const cx = align === 'start' ? bx : align === 'end' ? bx + bw : bx + bw / 2;
    svgParts.push(textBlockSVG({
      lines, size, cx, topY: by, anchor: align,
      uppercase: b.uppercase !== false,
      fill: b.color || '#fff',
      stroke: b.stroke === false ? null : (b.strokeColor || '#000'),
      font: b.font || 'impact',
    }));
  }
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('\n')}</svg>`;
  await sharp(imgPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
  return { width: W, height: H };
}

// --- caption modes -------------------------------------------------------
async function renderCaptionMode({ imgPath, caption, style = 'top', outPath }) {
  const meta = await sharp(imgPath).metadata();
  const W = meta.width, H = meta.height;

  if (style === 'top') {
    const size = Math.max(20, Math.round(W / 17));
    const { size: fSize, lines } = fitText(caption, W * 0.92, size * 6, size);
    const barH = Math.round(lines.length * fSize * 1.25 + fSize * 0.9);
    const svg = `<svg width="${W}" height="${barH}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${barH}" fill="#fff"/>` +
      lines.map((ln, i) => `<text x="${W / 2}" y="${Math.round((i + 0.95) * fSize * 1.22)}" font-family="'Segoe UI', Arial, sans-serif" font-size="${fSize}" font-weight="600" text-anchor="middle" fill="#111">${esc(ln)}</text>`).join('') +
      `</svg>`;
    await sharp(imgPath).extend({ top: barH, background: '#ffffff' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
    return { width: W, height: H + barH };
  }

  if (style === 'tiktok') {
    const size = Math.max(18, Math.round(W / 16));
    const { size: fSize, lines } = fitText(caption, W * 0.8, H * 0.5, size);
    const lineH = fSize * 1.3;
    const blockH = lines.length * lineH;
    const topY = (H - blockH) / 2;
    const parts = lines.map((ln, i) => {
      const tw = Math.min(W * 0.86, ln.length * fSize * 0.56 + fSize);
      const y = topY + i * lineH;
      return `<rect x="${(W - tw) / 2}" y="${y}" width="${tw}" height="${lineH}" rx="${fSize * 0.28}" fill="#fff"/>` +
        `<text x="${W / 2}" y="${y + lineH * 0.72}" font-family="'Segoe UI', Arial, sans-serif" font-size="${fSize}" font-weight="700" text-anchor="middle" fill="#111">${esc(ln)}</text>`;
    });
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
    await sharp(imgPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
    return { width: W, height: H };
  }

  // snapchat: translucent lower-third strip
  const size = Math.max(16, Math.round(W / 20));
  const { size: fSize, lines } = fitText(caption, W * 0.94, size * 4, size);
  const stripH = Math.round(lines.length * fSize * 1.3 + fSize);
  const stripY = Math.round(H * 0.68);
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="${stripY}" width="${W}" height="${stripH}" fill="rgba(0,0,0,0.55)"/>` +
    lines.map((ln, i) => `<text x="${W / 2}" y="${stripY + Math.round((i + 0.95) * fSize * 1.25)}" font-family="'Segoe UI', Arial, sans-serif" font-size="${fSize}" font-weight="500" text-anchor="middle" fill="#fff">${esc(ln)}</text>`).join('') +
    `</svg>`;
  await sharp(imgPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
  return { width: W, height: H };
}

// --- public API ----------------------------------------------------------
function resolveTemplateFile(file, tplDir, sub) {
  const base = tplDir || path.join(__dirname, '..', 'templates');
  if (path.isAbsolute(file)) return file;
  // harvested entries carry a sub-path ("harvest/media/x.webp"); seed entries are bare filenames
  return /[\\/]/.test(file) ? path.join(base, file) : path.join(base, sub, file);
}

async function renderMeme({ template, boxes, caption, captionStyle, outPath, tplDir }) {
  const imgPath = resolveTemplateFile(template.file, tplDir, 'images');
  if (!fs.existsSync(imgPath)) throw new Error('template image missing: ' + imgPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (caption != null && caption !== '') {
    return renderCaptionMode({ imgPath, caption, style: captionStyle || 'top', outPath });
  }
  // Merge caller boxes over the template's saved layout (or classic defaults) so every
  // box ALWAYS has geometry — a coordinate-less box would silently render nothing.
  const provided = boxes && boxes.length ? boxes : null;
  const layout = (template.boxes && template.boxes.length)
    ? template.boxes
    : defaultBoxes(Math.max(template.box_count || 2, provided ? provided.length : 0));
  const finalBoxes = provided
    ? provided.map((b, i) => ({ ...(layout[i] || layout[layout.length - 1] || { x: 5, y: 40, w: 90, h: 20 }), ...b }))
    : layout.map((b) => ({ ...b }));
  return renderTemplateMode({ imgPath, boxes: finalBoxes, outPath });
}

// Sanity: text must actually rasterize (fontconfig failure = blank overlay).
async function selfTest() {
  const tmp = path.join(__dirname, '..', 'logs', 'render-selftest.png');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const base = path.join(__dirname, '..', 'logs', 'render-selftest-base.png');
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).png().toFile(base);
  await renderTemplateMode({ imgPath: base, boxes: [{ x: 5, y: 5, w: 90, h: 40, text: 'FONT CHECK OK' }], outPath: tmp });
  const { data } = await sharp(tmp).raw().toBuffer({ resolveWithObject: true });
  let white = 0, black = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (data[i] > 240 && data[i + 1] > 240) white++;
    if (data[i] < 20 && data[i + 1] < 20) black++;
  }
  const ok = white > 500 && black > 200; // fill + stroke both present
  console.log(`RENDER SELFTEST ${ok ? 'PASS' : 'FAIL'} (white=${white} black=${black})`);
  return ok;
}

module.exports = { renderMeme, defaultBoxes, selfTest, resolveTemplateFile };
if (require.main === module) selfTest().then((ok) => { process.exitCode = ok ? 0 : 1; });
