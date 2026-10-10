// Video meme renderer — captioned video templates, mirroring the vendor's two styles:
//   "top"    = white letterbox bar above the video (their default for landscape/square)
//   "tiktok" = centered white-pill overlay (their vertical style)
// Caption raster comes from sharp (same look as image memes); ffmpeg only pads/overlays.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runFfmpeg, probe } = require('./ffmpeg.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrap(text, fontSize, maxWidth) {
  const per = Math.max(4, Math.floor(maxWidth / (fontSize * 0.54)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (cand.length <= per) cur = cand; else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

async function topBarPng(caption, W) {
  const size = Math.max(20, Math.round(W / 17));
  const lines = wrap(caption, size, W * 0.92);
  let barH = Math.round(lines.length * size * 1.25 + size * 0.9);
  if (barH % 2) barH++;
  const svg = `<svg width="${W}" height="${barH}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${barH}" fill="#fff"/>` +
    lines.map((ln, i) => `<text x="${W / 2}" y="${Math.round((i + 0.95) * size * 1.22)}" font-family="'Segoe UI', Arial, sans-serif" font-size="${size}" font-weight="600" text-anchor="middle" fill="#111">${esc(ln)}</text>`).join('') +
    `</svg>`;
  return { buf: await sharp(Buffer.from(svg)).png().toBuffer(), barH };
}

async function tiktokOverlayPng(caption, W, H) {
  const size = Math.max(18, Math.round(W / 14));
  const lines = wrap(caption, size, W * 0.8);
  const lineH = size * 1.3;
  const topY = (H - lines.length * lineH) / 2;
  const parts = lines.map((ln, i) => {
    const tw = Math.min(W * 0.9, ln.length * size * 0.56 + size);
    const y = topY + i * lineH;
    return `<rect x="${(W - tw) / 2}" y="${y}" width="${tw}" height="${lineH}" rx="${size * 0.28}" fill="#fff"/>` +
      `<text x="${W / 2}" y="${y + lineH * 0.72}" font-family="'Segoe UI', Arial, sans-serif" font-size="${size}" font-weight="700" text-anchor="middle" fill="#111">${esc(ln)}</text>`;
  });
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderVideoMeme({ videoPath, caption, style = 'top', outPath }) {
  if (!fs.existsSync(videoPath)) throw new Error('video template missing: ' + videoPath);
  const info = probe(videoPath);
  const v = info.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream in ' + videoPath);
  const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
  const W = v.width - (v.width % 2), H = v.height - (v.height % 2);
  // default style by orientation, mirroring their dimension-based behavior
  if (!style) style = H > W ? 'tiktok' : 'top';

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'someme-'));
  const overlayPath = path.join(tmp, 'cap.png');
  try {
    let filter;
    if (style === 'tiktok') {
      fs.writeFileSync(overlayPath, await tiktokOverlayPng(caption, W, H));
      filter = `[0:v]scale=${W}:${H}[base];[base][1:v]overlay=0:0`;
    } else {
      const { buf, barH } = await topBarPng(caption, W);
      fs.writeFileSync(overlayPath, buf);
      filter = `[0:v]scale=${W}:${H},pad=${W}:${H + barH}:0:${barH}:color=white[base];[base][1:v]overlay=0:0`;
    }
    const args = ['-i', videoPath, '-i', overlayPath, '-filter_complex', filter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k'); else args.push('-an');
    args.push(outPath);
    await runFfmpeg(args);
    const out = probe(outPath);
    return { duration: parseFloat(out.format.duration), width: W, height: style === 'top' ? null : H, size_mb: (out.format.size / 1048576).toFixed(2) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { renderVideoMeme };
