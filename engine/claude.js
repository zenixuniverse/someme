// Shared `claude -p` helper. Windows traps handled:
//  - claude is a .CMD shim → must go through cmd.exe /c (spawn('claude') fails silently)
//  - prompt goes on STDIN (argv hits cmd.exe's ~8191-char cap)
//  - utf8 everywhere; both streams drained
const { spawn } = require('child_process');

function askClaude(prompt, { allowedTools = '', timeoutMs = 240000, model = '' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['/c', 'claude', '-p', '--output-format', 'text'];
    if (allowedTools) args.push('--allowedTools', allowedTools);
    if (model) args.push('--model', model);
    const child = spawn('cmd.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new Error('claude timeout after ' + timeoutMs + 'ms')); } }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(t);
      if (code !== 0 && !out.trim()) return reject(new Error('claude exit ' + code + ': ' + err.slice(-800)));
      resolve(out.trim());
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

// Pull the first JSON object/array out of a model response (tolerates prose/fences around it).
function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  for (const open of ['{', '[']) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    const close = open === '{' ? '}' : ']';
    const end = text.lastIndexOf(close);
    if (end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try next */ } }
  }
  throw new Error('no parseable JSON in response: ' + text.slice(0, 200));
}

module.exports = { askClaude, extractJSON };
