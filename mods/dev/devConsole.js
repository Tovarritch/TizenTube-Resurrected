// DEBUG BUNDLE ONLY (dbgs/userScript.js, loaded by debug APKs). Never in
// dist/userScript.js. Runs JavaScript sent from the PC (scripts/tv.py) through
// the debug APK's loopback DevConsole and sends back the result.
import { configRead, configWrite } from '../config.js';
import resolveCommand from '../resolveCommand.js';

const BASE = 'http://127.0.0.1:18946';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helpers available to commands as `tt`.
window.tt = {
  get: key => configRead(key),
  set: (key, value) => { configWrite(key, value); return configRead(key); },
  cmd: command => resolveCommand(command),
  // Short description of elements: tag, idomkey, classes and box.
  el(selector, limit = 10) {
    return [...document.querySelectorAll(selector)].slice(0, limit).map(e => {
      const r = e.getBoundingClientRect();
      return `${e.tagName.toLowerCase()}${e.getAttribute('idomkey') ? `[${e.getAttribute('idomkey')}]` : ''}`
        + ` x=${Math.round(r.left)} y=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)}`
        + ` text="${(e.innerText || '').slice(0, 60).replace(/\s+/g, ' ')}"`;
    });
  },
  text: (selector = 'body') => (document.querySelector(selector)?.innerText || '').slice(0, 4000),
};

// Leak recorder: members-only videos that are actually displayed, despite the
// filter. Checks the data behind the tiles on screen every 5 seconds and keeps
// what it finds across restarts (tt.leaks() reads, tt.leaks(true) clears).
const LEAK_KEY = 'tt-dev-leaks';
const LEAK_MARK = /MEMBERS_ONLY|SPONSORS_ONLY|members[ -]only|doar pentru membri|"iconType":"[A-Z_]*MEMBER/i;
const reported = new Set();
setInterval(() => {
  for (const tile of document.querySelectorAll('ytlr-tile-renderer, ytlr-lockup-view-model')) {
    const data = tile.__instance?.props?.data;
    const id = data?.contentId || data?.tileRenderer?.contentId;
    if (!data || reported.has(id)) continue;
    const text = JSON.stringify(data);
    const mark = text.match(LEAK_MARK);
    if (!mark) continue;
    reported.add(id);
    const row = tile.closest('ytlr-shelf-renderer');
    try {
      const leaks = JSON.parse(localStorage.getItem(LEAK_KEY) || '[]');
      leaks.push({ at: new Date().toISOString(), hash: location.hash, build: window.tizenTubeBuild, id,
        title: (tile.innerText || '').split(/\n/)[0].slice(0, 60), row: (row?.innerText || '').split(/\n/)[0].slice(0, 40),
        mark: text.slice(Math.max(0, mark.index - 120), mark.index + 60) });
      localStorage.setItem(LEAK_KEY, JSON.stringify(leaks.slice(-30)));
    } catch (_) {}
  }
}, 5000);
window.tt.leaks = clear => {
  if (clear) { localStorage.removeItem(LEAK_KEY); return []; }
  try { return JSON.parse(localStorage.getItem(LEAK_KEY) || '[]'); } catch (_) { return []; }
};

function serialize(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return '(undefined)';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Element) return value.outerHTML.slice(0, 2000);
  if (seen.has(value) || depth > 6) return '[…]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(v => serialize(v, depth + 1, seen));
  const out = {};
  for (const key of Object.keys(value).slice(0, 200)) {
    try { out[key] = serialize(value[key], depth + 1, seen); } catch (e) { out[key] = `[${e}]`; }
  }
  return out;
}

// YouTube requires Trusted Types for scripts, so strings run through a policy.
const policy = window.trustedTypes?.createPolicy?.('tizentube-dev-console', { createScript: source => source });
async function run(code) {
  try {
    const source = `(async () => {\n${code}\n})()`;
    const value = await (0, eval)(policy ? policy.createScript(source) : source);
    return { ok: true, value: serialize(value) };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error) };
  }
}

async function loop() {
  for (;;) {
    try {
      const response = await fetch(`${BASE}/poll`);
      if (response.status === 200) {
        const { id, code } = await response.json();
        const result = await run(code);
        // text/plain keeps this a simple request (no CORS preflight).
        await fetch(`${BASE}/result?id=${encodeURIComponent(id)}`, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(result),
        });
      } else if (response.status !== 204) {
        await sleep(3000);
      }
    } catch (_) {
      await sleep(5000);
    }
  }
}
loop();
