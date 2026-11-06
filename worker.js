/**
 * Global Fault Lines: live-data proxy + prep-alarm cron (Cloudflare Worker)
 *
 * What it does
 *   GET /              the live atlas page itself (same origin → no CORS, no proxy setup)
 *   GET /fetch?url=…   CORS proxy with edge caching, limited to VIEWS, GDELT and Polymarket
 *   GET /alarms        alarms raised by the cron in the last 48 h (the page polls this)
 *   cron (*\/15 min)    evaluates the same rules as the page and pushes PREP/WATCH alarms
 *                      to your phone via ntfy (free app: https://ntfy.sh)
 *
 * Deploy (≈3 min)
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler kv namespace create STATE     → paste the id into wrangler.toml
 *   3. wrangler secret put NTFY_TOPIC         → a long random topic name, e.g. gfl-7f3k9q2x…
 *      (optional) wrangler secret put NTFY_TOKEN  if you use a protected/self-hosted ntfy topic
 *   4. wrangler deploy
 *   5. Open https://fault-lines.<you>.workers.dev. That's the live page. Subscribe to the same
 *      topic in the ntfy app and set PAGE_URL in wrangler.toml so tapping an alert opens it.
 *   Keep global_fault_lines_v4.html next to this file; it is bundled into the Worker.
 */

import PAGE from './global_fault_lines_v4.html';

const ALLOW = {
  'api.viewsforecasting.org': 6 * 3600,
  'api.gdeltproject.org': 900,
  'gamma-api.polymarket.com': 120,
};

/* Must stay in sync with the page's hotspot list (only the fields the rules need). */
const REGIONS = [
  { id: 'ukraine', name: 'Russia-Ukraine', type: 'war', q: '(Ukraine OR Ukrainian OR Kyiv) (attack OR strike OR offensive OR drone OR missile OR shelling)', pm: 'Ukraine', pmRe: /ukrain|russia|putin|zelensk/i },
  { id: 'sudan', name: 'Sudan', type: 'human', q: '(Sudan OR Darfur OR "El Fasher" OR Khartoum OR "Rapid Support Forces") (attack OR killed OR fighting OR clashes OR drone)', pm: 'Sudan', pmRe: /sudan|\brsf\b/i },
  { id: 'gaza', name: 'Gaza / Israel-Palestine', type: 'human', q: '(Gaza OR "West Bank") (killed OR strike OR attack OR ceasefire OR aid)', pm: 'Gaza', pmRe: /gaza|hamas|israel/i },
  { id: 'iran', name: 'Iran / Persian Gulf', type: 'war', q: '(Iran OR Iranian OR Hormuz) (strike OR attack OR missile OR military OR retaliation)', pm: 'Iran', pmRe: /iran|hormuz|khamenei/i },
  { id: 'taiwan', name: 'Taiwan Strait', type: 'flash', q: 'Taiwan (PLA OR "Chinese military" OR drills OR blockade OR warships OR incursion)', pm: 'Taiwan', pmRe: /taiwan/i },
  { id: 'myanmar', name: 'Myanmar', type: 'human', q: '(Myanmar OR Burma) (airstrike OR fighting OR killed OR offensive OR clashes)', pm: 'Myanmar', pmRe: /myanmar|burma/i },
  { id: 'congo', name: 'Eastern DR Congo', type: 'human', q: '("DR Congo" OR "eastern Congo" OR Goma OR M23 OR Kivu) (fighting OR killed OR attack OR clashes OR rebels)', pm: 'Congo', pmRe: /\bdrc\b|dr congo|democratic republic of the congo|eastern congo|\bm23\b|goma|\bkivu\b|rwanda/i },
  { id: 'sahel', name: 'Central Sahel', type: 'human', q: '(Mali OR "Burkina Faso" OR Niger OR Sahel) (attack OR jihadist OR killed OR militants OR ambush)', pm: 'Mali', pmRe: /\bmali\b|burkina|\bniger\b|sahel/i },
  { id: 'korea', name: 'Korean Peninsula', type: 'flash', q: '("North Korea" OR Pyongyang OR DPRK) (missile OR launch OR military OR nuclear OR artillery)', pm: 'North Korea', pmRe: /north korea|kim jong|dprk/i },
  { id: 'kashmir', name: 'India-Pakistan / Kashmir', type: 'flash', q: '(Kashmir OR "Line of Control" OR "India Pakistan") (attack OR firing OR militants OR strike OR killed)', pm: 'India Pakistan', pmRe: /india|pakistan|kashmir/i },
  { id: 'yemen', name: 'Yemen / Red Sea', type: 'war', q: '(Yemen OR Houthi OR Houthis OR "Red Sea") (attack OR strike OR missile OR ship OR drone)', pm: 'Houthi', pmRe: /houthi|yemen|red sea/i },
  { id: 'haiti', name: 'Haiti', type: 'human', q: '(Haiti OR "Port-au-Prince") (gang OR gangs OR killed OR violence OR attack)', pm: 'Haiti', pmRe: /haiti/i },
  { id: 'somalia', name: 'Somalia', type: 'war', q: '(Somalia OR "al-Shabaab" OR Mogadishu) (attack OR killed OR airstrike OR militants)', pm: 'Somalia', pmRe: /somali/i },
  { id: 'southchina', name: 'South China Sea', type: 'flash', q: '("South China Sea" OR Scarborough OR "Second Thomas Shoal" OR Spratly) ("coast guard" OR collision OR "water cannon" OR navy OR confrontation)', pm: 'South China Sea', pmRe: /south china sea|philippines|scarborough/i },
  { id: 'lebanon', name: 'Lebanon / Israel border', type: 'war', q: '(Lebanon OR Hezbollah) (strike OR attack OR killed OR ceasefire OR rocket)', pm: 'Hezbollah', pmRe: /hezbollah|lebanon/i },
  { id: 'ethiopia', name: 'Ethiopia', type: 'human', q: '(Ethiopia OR Amhara OR Tigray OR Fano OR Oromia) (fighting OR killed OR clashes OR attack OR drone)', pm: 'Ethiopia', pmRe: /ethiopia|eritrea|tigray/i },
];
const GLOBAL_Q = '("declares war" OR "declared war" OR "full-scale invasion" OR "naval blockade" OR "martial law" OR "general mobilization" OR "nuclear strike" OR "nuclear alert" OR "attack on NATO")';
const COOLDOWN_MS = 12 * 3600e3;

/* ---------- shared rule maths (mirrors the page) ---------- */
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
function dailySpike(json) {
  const v = (json?.timeline?.[0]?.data || []).map(d => +d.value).filter(Number.isFinite);
  if (v.length < 20) return null;
  const today = v.at(-1), win = v.slice(-31, -1), bm = mean(win), bs = sd(win);
  return { ratio: bm > 0 ? today / bm : null, z: bs > 0 ? (today - bm) / bs : null };
}
function spikeStats(json, k = 4) {
  const v = (json?.timeline?.[0]?.data || []).map(d => +d.value).filter(Number.isFinite);
  if (v.length < k * 4) return null;
  const recent = mean(v.slice(-k)), win = v.slice(0, -k), bm = mean(win), bs = sd(win) / Math.sqrt(k);
  return { ratio: bm > 0 ? recent / bm : null, z: bs > 0 ? (recent - bm) / bs : null };
}
function parseMarkets(json, re, minVol = 1000) {
  const out = [], seen = new Set();
  for (const ev of json?.events || []) for (const m of ev.markets || []) {
    if (m.closed || m.active === false || m.archived) continue;
    let o, pr;
    try { o = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes; pr = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; } catch { continue; }
    if (!Array.isArray(o) || o.length !== 2 || !/^yes$/i.test(o[0])) continue;
    const p = +pr?.[0]; if (!Number.isFinite(p)) continue;
    if (m.endDate && Date.parse(m.endDate) < Date.now()) continue;
    const q = m.question || ev.title || ''; if (re && !re.test(q + ' ' + (ev.title || ''))) continue;
    const vol = +(m.volumeNum ?? m.volume ?? 0) || 0; if (vol < minVol || seen.has(q)) continue; seen.add(q);
    out.push({ q, p, vol, url: 'https://polymarket.com/event/' + encodeURIComponent(ev.slug || '') });
  }
  return out.sort((a, b) => b.vol - a.vol).slice(0, 4);
}
function marketDelta(hist, now) {
  if (!hist || hist.length < 2) return null;
  const cur = hist.at(-1)[1], target = now - 864e5; let ref = null;
  for (const h of hist) if (h[0] <= target) ref = h;
  if (!ref) { const o = hist[0]; if (now - o[0] < 6 * 3600e3) return null; ref = o; }
  return { d: cur - ref[1], from: ref[1], to: cur, hours: Math.round((now - ref[0]) / 3600e3) };
}

/* market direction: does YES mean more danger (+1), less (-1) or unclear (0)? */
const DEESC=/ceasefire|cease-fire|truce|peace|deal|agreement|negotiat|talks|end (the|of)|ends?\b|withdraw|release|normaliz|recogni[sz]e|reopen/i;
const ESC=/invade|invasion|attack|strike|war\b|blockade|clash|military action|nuclear|missile|bomb|conflict|escalat|declare|mobiliz|captur|seize|annex|enter|troops/i;
function polarity(q){return DEESC.test(q)?-1:ESC.test(q)?1:0}

/* ---------- helpers ---------- */
const cors = (h = new Headers()) => { h.set('Access-Control-Allow-Origin', '*'); h.set('Access-Control-Allow-Methods', 'GET, OPTIONS'); h.set('Access-Control-Allow-Headers', 'Content-Type'); return h; };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors(new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function upstream(url, ctx) {
  const target = new URL(url);
  const ttl = ALLOW[target.hostname];
  if (target.protocol !== 'https:' || !ttl) throw Object.assign(new Error('host not allowed'), { status: 403 });
  const cache = caches.default, key = new Request(target.toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(target.toString(), { headers: { 'User-Agent': 'global-fault-lines/1.0 (+cloudflare-worker)', Accept: 'application/json' } });
  const body = await r.text();
  const res = new Response(body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': `public, max-age=${ttl}` } });
  const looksJson = /^\s*[[{]/.test(body);
  if (r.ok && looksJson && ctx) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
async function getJSON(url, ctx) {
  const r = await upstream(url, ctx); const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + (t.trim() ? ': ' + t.trim().slice(0, 120) : ''));
  /* GDELT serves its rate-limit refusal as HTTP 200 with Content-Type: application/json
     but a plain-text body, so status alone cannot be trusted. Surface the upstream text
     instead of an opaque JSON.parse SyntaxError. */
  try { return JSON.parse(t); }
  catch { throw new Error(t.trim().slice(0, 120) || 'Empty response'); }
}
const gdeltURL = p => 'https://api.gdeltproject.org/api/v2/doc/doc?' + new URLSearchParams({ ...p, format: 'json' });

async function loadState(env) { return (env.STATE && (await env.STATE.get('state', 'json'))) || { prices: {}, fired: {}, alarms: [] }; }
async function saveState(env, s) { if (env.STATE) await env.STATE.put('state', JSON.stringify(s)); }

async function push(env, a) {
  if (!env.NTFY_TOPIC) return;
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  const ascii = s => s.replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '');
  const headers = { Title: ascii((a.level === 'prep' ? 'PREP ALARM: ' : 'Watch: ') + a.title), Priority: a.level === 'prep' ? '5' : '3', Tags: a.level === 'prep' ? 'rotating_light' : 'warning' };
  if (env.PAGE_URL) headers.Click = env.PAGE_URL;
  if (env.NTFY_TOKEN) headers.Authorization = 'Bearer ' + env.NTFY_TOKEN;
  const body = a.why + (a.level === 'prep' ? '\n\nVerify first via Alertswiss / official channels. Check supplies (9 L water per person, food for about a week), charge devices, review your family plan.' : '');
  await fetch(`${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, { method: 'POST', headers, body });
}

/* ---------- cron: evaluate rules, push new alarms ---------- */
async function runChecks(env, ctx) {
  const k = { low: 1.4, normal: 1, high: 0.75 }[env.SENSITIVITY || 'normal'] || 1;
  const state = await loadState(env), now = Date.now(), found = [];

  try {
    const g = spikeStats(await getJSON(gdeltURL({ query: GLOBAL_Q, mode: 'timelinevol', timespan: '7d' }), ctx));
    if (g?.ratio != null && g.z != null) {
      if (g.ratio >= 3 * k && g.z >= 4 * k) found.push({ key: 'global-surge', level: 'prep', region: null, title: 'Global surge in severe-escalation reporting', why: `Coverage of war declarations, blockades, mobilization or nuclear alerts is ${g.ratio.toFixed(1)}x its 7-day baseline (z ${g.z.toFixed(1)}).` });
      else if (g.ratio >= 2 * k && g.z >= 3 * k) found.push({ key: 'global-surge', level: 'watch', region: null, title: 'Rising severe-escalation reporting', why: `Escalation-keyword coverage is ${g.ratio.toFixed(1)}x baseline (z ${g.z.toFixed(1)}).` });
    }
  } catch (e) { console.log('global', e.message); }

  /* GDELT refuses with HTTP 200 + a plain-text "Please limit requests…" body. Once it is
     refusing this IP there is no point pacing through all 16 regions for ~88 s, so give up
     on news after a few consecutive refusals and let the market checks run unthrottled. */
  const rateLimited = e => /please limit requests|HTTP 429/i.test(e.message || '');
  let gdeltStrikes = 0, gdeltOff = false;

  for (const d of REGIONS) {
    const big = d.type !== 'human';
    try {
      if (gdeltOff) throw new Error('GDELT skipped (rate-limited earlier this run)');
      await sleep(5500); // GDELT: ≤1 request / 5 s
      const s = dailySpike(await getJSON(gdeltURL({ query: d.q, mode: 'timelinevol', timespan: '90d' }), ctx));
      gdeltStrikes = 0;
      if (s?.ratio != null && s.z != null) {
        if (big && s.ratio >= 3 * k && s.z >= 4 * k) found.push({ key: 'news-' + d.id, level: 'prep', region: d.id, title: `${d.name}: sudden news surge`, why: `Today's conflict coverage is ${s.ratio.toFixed(1)}x its 30-day average (z ${s.z.toFixed(1)}).` });
        else if (s.ratio >= 2.2 * k && s.z >= 3 * k) found.push({ key: 'news-' + d.id, level: 'watch', region: d.id, title: `${d.name}: news spike`, why: `Today's conflict coverage is ${s.ratio.toFixed(1)}x its 30-day average (z ${s.z.toFixed(1)}).` });
      }
    } catch (e) {
      console.log('news', d.id, e.message);
      if (rateLimited(e) && ++gdeltStrikes >= 3) { gdeltOff = true; console.log('news', 'GDELT rate-limited, skipping remaining regions this run'); }
    }
    try {
      const mk = parseMarkets(await getJSON('https://gamma-api.polymarket.com/public-search?' + new URLSearchParams({ q: d.pm, events_status: 'active' }), ctx), d.pmRe);
      for (const m of mk) {
        const h = (state.prices[m.q] ||= []);
        if (!h.length || now - h.at(-1)[0] > 10 * 60e3) h.push([now, m.p]);
        const dl = marketDelta(h, now); if (!dl) continue;
        const pol = polarity(m.q), risk = dl.d * (pol || 1), pp = Math.round(dl.d * 100), key = 'mkt-' + d.id + '-' + m.q.slice(0, 40);
        const why = `"${m.q}" moved ${pp > 0 ? '+' : ''}${pp} pts to ${Math.round(dl.to * 100)}% in ${dl.hours}h${pol < 0 ? ' (a de-escalation market falling)' : ''}.`;
        if (pol > 0 && big && m.vol >= 50000 && (dl.d >= 0.2 * k || (dl.from < 0.5 && dl.to >= 0.5 && dl.d >= 0.1 * k))) found.push({ key, level: 'prep', region: d.id, title: `${d.name}: crowd odds of escalation jumped`, why, url: m.url });
        else if (pol !== 0 && risk >= 0.1 * k) found.push({ key, level: 'watch', region: d.id, title: `${d.name}: odds shifting toward escalation`, why, url: m.url });
        else if (pol === 0 && Math.abs(dl.d) >= 0.15 * k) found.push({ key, level: 'watch', region: d.id, title: `${d.name}: odds moving sharply`, why, url: m.url });
      }
    } catch (e) { console.log('pm', d.id, e.message); }
  }

  for (const q in state.prices) { state.prices[q] = state.prices[q].filter(h => now - h[0] < 50 * 3600e3); if (!state.prices[q].length) delete state.prices[q]; }
  for (const a of found) {
    const last = state.fired[a.key];
    if (last && now - last.t < COOLDOWN_MS && !(a.level === 'prep' && last.level === 'watch')) continue;
    state.fired[a.key] = { t: now, level: a.level };
    a.t = now; state.alarms.unshift(a);
    try { await push(env, a); } catch (e) { console.log('push', e.message); }
  }
  for (const key in state.fired) if (now - state.fired[key].t > 7 * 864e5) delete state.fired[key];
  state.alarms = state.alarms.filter(a => now - a.t < 48 * 3600e3).slice(0, 50);
  state.lastRun = now;
  await saveState(env, state);
  return { found: found.length, lastRun: now };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const u = new URL(req.url);
    try {
      if (u.pathname === '/' || u.pathname === '/index.html') {
        const html = PAGE.replace('<head>', '<head><script>window.GFL_SELF_HOSTED=true</script>');
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
      }
      if (u.pathname === '/fetch') {
        const res = await upstream(u.searchParams.get('url') || '', ctx);
        const out = new Response(res.body, res); cors(out.headers); return out;
      }
      if (u.pathname === '/alarms') {
        const s = await loadState(env);
        return json({ alarms: s.alarms || [], lastRun: s.lastRun || null, kv: !!env.STATE, push: !!env.NTFY_TOPIC });
      }
      if (u.pathname === '/test-push' && env.TEST_KEY && u.searchParams.get('key') === env.TEST_KEY) {
        await push(env, { level: 'prep', title: 'Test from Global Fault Lines', why: 'If you can read this, phone alerts work.' });
        return json({ ok: true });
      }
      if (u.pathname === '/health') return json({ ok: true, endpoints: ['/', '/fetch?url=', '/alarms'], allow: Object.keys(ALLOW) });
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, e.status || 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, ctx).then(
      r => console.log('checks', JSON.stringify(r)),
      e => console.log('checks failed', e?.stack || e?.message || String(e)),
    ));
  },
};
