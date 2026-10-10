// ffmpeg/ffprobe resolver + runner. winget's Gyan.FFmpeg is on the USER PATH but not
// necessarily this process's — scan the WinGet Packages dir as fallback (playbook lesson).
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let cached = null;
function resolveFfmpeg() {
  if (cached) return cached;
  for (const name of ['ffmpeg']) {
    const r = spawnSync(name, ['-version'], { encoding: 'utf8' });
    if (!r.error) { cached = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }; return cached; }
  }
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(pk)) {
    for (const dir of fs.readdirSync(pk)) {
      if (!/ffmpeg/i.test(dir)) continue;
      const root = path.join(pk, dir);
      for (const sub of fs.readdirSync(root)) {
        const bin = path.join(root, sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(bin)) { cached = { ffmpeg: bin, ffprobe: path.join(root, sub, 'bin', 'ffprobe.exe') }; return cached; }
      }
    }
  }
  throw new Error('ffmpeg not found (PATH or WinGet Packages). Install: winget install Gyan.FFmpeg');
}

// run ffmpeg with -nostdin, both streams drained (spawn deadlock lesson)
function runFfmpeg(args, { cwd } = {}) {
  const { ffmpeg } = resolveFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-y', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; if (err.length > 4e5) err = err.slice(-2e5); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-600))));
  });
}

function probe(file) {
  const { ffprobe } = resolveFfmpeg();
  const r = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + (r.stderr || '').slice(-300));
  return JSON.parse(r.stdout);
}

module.exports = { resolveFfmpeg, runFfmpeg, probe };
