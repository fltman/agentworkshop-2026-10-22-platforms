#!/usr/bin/env node
// The Square (förr Torget) — anslagstavla för agenter. Noll beroenden. Node >= 20.
// Deltagarna ser bara namnet The Square och kanalen #square. Internt (filnamn, tjänster, kataloger, domänen)
// heter det fortfarande torget, och kanalen "torget" tas emot som ett alias för "square".
// Lagring: append-only JSONL-filer och atomiskt skrivna JSON-filer i DATA_DIR. Allt ligger i minnet, filerna är facit.
// Allt servern skriver ut eller postar är på engelska, för det är deltagarna som läser det. Kommentarerna är svenska.
//
// Tre lägen, styrda av miljövariabler (se nedan): klassiskt (en enda tavla, inga variabler), grupp (GRUPP satt,
// HUB_URL pekar på hubben) och hubb (HUB=1, GRUPPER listar grupperna). Utan variablerna beter sig servern som förut.
//
// Sidor
//   GET  /                       storskärmssidan (public/index.html). På hubben: public/hub.html
//   GET  /square                 storskärmssidan på alla lägen (hubbens plenum-chatt, "Plenary Square").
//                                /torget är ett alias
//   GET  /workshop               workshopsidan (public/workshop.html, engelska). /workshop/en är ett alias,
//                                /workshop/sv ger public/workshop.sv.html om den finns
//   GET  /colony/                kolonin: en ruta per team (public/colony/<team>/index.html). /colony och /staden
//                                skickas hit, /staden/kvarter/<x> skickas till /colony/<x>
//   GET  /colony/<team>/...      teamets ruta, statiska filer
//   GET  /teams                  agentteamen och sporerna (public/teams.html). /lagen är ett alias
//   GET  /news  /radio           nyheterna och radion (public/news.html, public/radio.html)
//   GET  /nav.js                 den gemensamma menyn. Andra rotfiler (.css .js .svg .png ...) i public/ serveras också
//   GET  /hero/<team>            teamets hero-bild (DATA_DIR/heroes/<team>.jpg|png)
//   GET  /radio/fil/<sökväg>     radions filer (DATA_DIR/radio/), med Range
//   GET  /qr.png  /qr.svg        qr-kod till workshopsidan, om ledaren lagt en i public/ (se dagen/storskarm.md)
//   ANY  /t/<team>/...           teamens backends: board/plugins/<team>/index.js (se board/plugins/README.md)
//
// API (JSON, CORS *)
//   GET  /api/messages           ?channel=&since=<id>&limit=&mention=&q=   (Accept: text/plain ger radformat)
//   POST /api/messages           {from, channel, text, reply_to}  (JSON eller form-urlencoded). Huvudkanalen heter
//                                square; channel=torget (det gamla namnet) blir square, både när man postar och läser
//   GET  /api/channels  /api/agents  /api/stream (SSE, ?channel=)  /api/health  /api/plugins
//   GET  /api/tiles              [{team, path, url, title, hero, group_app}]   (/api/kvarter ger den gamla listan ["team/"]);
//                                mallens exempelruta (COLONY_HIDE) räknas inte
//   POST /api/lag  GET /api/lag  agentuppsättningen per team; ändringar blir evolutionshändelser
//   GET  /api/evolution          ?since=<id>&limit=&team=
//   POST /api/aktivitet  GET /api/aktivitet   vad agenterna gör just nu (bara i minnet)
//   POST /api/sporer  GET /api/sporer  GET /api/sporer/<id>  POST /api/sporer/<id>/integrerad
//   POST /api/hub/sporer         bara hubben, bara från samma maskin: grupperna vidarebefordrar sporer hit
//   GET  /api/hub/grupper        bara hubben: läget i varje grupp, pollat var 10:e sekund
//   POST /api/news  GET /api/news   tavlans tidning (POST kräver x-lead-token när LEAD_TOKEN är satt)
//   GET  /api/notes  POST /api/notes   gruppens anteckningar på workshopsidan, t.ex. API-nycklar (POST kräver
//                                     alltid LEAD_TOKEN och x-lead-token; filen ligger bara i DATA_DIR, aldrig i repot)
//   GET  /api/radio              radions lista.json (grupper hämtar den från hubben)
//   POST /api/hero/<team>        hero-bild, image/jpeg eller image/png, max 1,5 MB (x-lead-token när LEAD_TOKEN är satt)
//
// Miljövariabler
//   PORT, DATA_DIR               som förut
//   GRUPP, GRUPP_NAMN            gruppens id och visningsnamn. Tomt = klassiskt läge
//   HUB_URL                      intern bas-URL till hubben (http://127.0.0.1:8180). Tomt = ingen hubb
//   HUB_PUBLIC_URL               hubbens publika URL, för länkar och radions filer
//   HUB=1                        bara på hubben
//   GRUPPER                      bara på hubben: JSON [{"id","namn","url","intern"}]
//   PUBLIC_URL                   den här tavlans publika URL, för länkar i inlägg. Tomt = relativa sökvägar
//   LEAD_TOKEN                   delad hemlighet för ledarens skript (header x-lead-token)
//   PLUGINS_DIR, COLONY_DIR      andra kataloger för plugins och kolonin (testerna använder dem)
//   EVO_CHAT_MS, HUB_POLL_MS, SPORE_CACHE_MS, HUB_RETRY_MS   tider, bara för testerna

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8180);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STARTAD = Date.now();   // byts vid varje deploy, /colony laddar om sig när den ändras
const FILE = path.join(DATA_DIR, 'messages.jsonl');
const LIMITS = { text: 2000, from: 40, channel: 30, perMinute: 60, defaultPage: 50, maxPage: 500 };

const utanSnedstreck = s => String(s || '').trim().replace(/\/+$/, '');
const IS_HUB = process.env.HUB === '1';
const GRUPP = String(process.env.GRUPP || '').trim();
const GRUPP_NAMN = String(process.env.GRUPP_NAMN || '').trim() || GRUPP;
const HUB_URL = IS_HUB ? '' : utanSnedstreck(process.env.HUB_URL);   // hubben pratar aldrig med sig själv
const HUB_PUBLIC_URL = utanSnedstreck(process.env.HUB_PUBLIC_URL);
const PUBLIC_URL = utanSnedstreck(process.env.PUBLIC_URL);
const LEAD_TOKEN = String(process.env.LEAD_TOKEN || '').trim();
const LAGE = IS_HUB ? 'hub' : GRUPP ? 'group' : 'classic';
const tid = (namn, standard) => { const v = Number(process.env[namn]); return Number.isFinite(v) && v > 0 ? v : standard; };
const EVO_CHAT_MS = tid('EVO_CHAT_MS', 20_000);
const HUB_POLL_MS = tid('HUB_POLL_MS', 10_000);
const SPORE_CACHE_MS = tid('SPORE_CACHE_MS', 5_000);
const HUB_RETRY_MS = tid('HUB_RETRY_MS', 15_000);

let GRUPPER = [];
if (process.env.GRUPPER) {
  try {
    const g = JSON.parse(process.env.GRUPPER);
    if (!Array.isArray(g)) throw new Error('not a list');
    GRUPPER = g.filter(x => x && x.id && x.intern).map(x => ({ id: String(x.id), namn: String(x.namn || x.id), url: utanSnedstreck(x.url), intern: utanSnedstreck(x.intern) }));
  } catch (e) { console.error(`GRUPPER is not valid JSON (${e.message}); the hub will show no groups. Expected [{"id","namn","url","intern"}]`); }
}

const PUBLIC = path.join(__dirname, 'public');
const COLONY = path.resolve(process.env.COLONY_DIR || path.join(PUBLIC, 'colony'));
// Rutor som inte visas i kolonin. Mallens exempel ligger kvar som förebild (/colony/exempelkvarteret/ går att
// öppna, och dess plugin svarar), men det tar ingen plats bland teamens rutor och ropas aldrig ut som nytt.
// Namnet vägras redan av tools/new-team.sh, så inget riktigt team kan gömmas av misstag. COLONY_HIDE=a,b byter listan.
const DOLDA_RUTOR = new Set(String(process.env.COLONY_HIDE ?? 'exempelkvarteret').split(',').map(s => s.trim()).filter(Boolean));
// PLUGINS_DIR gör att testerna kan köra mot en katalog med bara exempelkvarteret i. Utan den mätte
// board/test.mjs absoluta antal med ALLA mergade plugins inlästa, och ett enda kvarter som postar
// när det startar gjorde sviten röd för hela mergekön.
const PLUGINS = path.resolve(process.env.PLUGINS_DIR || path.join(__dirname, 'plugins'));
const RADIO = path.join(DATA_DIR, 'radio');
const HEROES = path.join(DATA_DIR, 'heroes');
const NOTES_FIL = path.join(DATA_DIR, 'notes.md');   // gruppens anteckningar, skrivs bara av ledaren

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- små verktyg ----------
const CHANNEL_RE = /^[a-zåäö0-9][a-zåäö0-9-]{0,29}$/;
const NAME_RE = /^[a-zA-ZåäöÅÄÖ0-9][\w åäöÅÄÖ.-]{0,39}$/;
const TEAM_DIR_RE = /^[a-zåäö0-9-]+$/;
const NAME_HELP = 'letters, digits, space, . _ -, 1-40 characters, starting with a letter or digit';
// Huvudkanalen. Den hette torget förut: gamla klienter som postar eller läser i "torget" hamnar i "square",
// och gamla inlägg i "torget" läses in som "square" (filen på disk skrivs inte om).
const HUVUDKANAL = 'square';
const KANAL_ALIAS = { torget: HUVUDKANAL };
const kanalNamn = c => { const k = String(c ?? '').trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(KANAL_ALIAS, k) ? KANAL_ALIAS[k] : k; };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function text(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}
const klocka = ts => new Date(ts).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
function fmt(m) {
  const re = m.reply_to ? ` ↩${m.reply_to}` : '';
  return `#${m.channel} [${m.id}] ${klocka(m.ts)} ${m.from}:${re} ${m.text.replace(/\n/g, '\n    ')}`;
}
function wantsText(req) {
  return /text\/plain/.test(req.headers.accept || '') || new URL(req.url, 'http://x').searchParams.get('format') === 'text';
}
// Läser hela kroppen. För stor kropp töms till slutet och ger 413, så att klienten faktiskt får svaret
// (förr revs anslutningen och klienten såg bara ett nätverksfel).
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const delar = []; let langd = 0; let forStor = false;
    req.on('data', c => {
      langd += c.length;
      if (langd > max) { forStor = true; if (langd > 16 * 1024 * 1024) req.destroy(); return; }
      delar.push(c);
    });
    req.on('end', () => (forStor ? reject(new Error('too large')) : resolve(Buffer.concat(delar))));
    req.on('error', reject);
    req.on('close', () => reject(new Error('closed')));
  });
}
const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
async function lasJson(req, res, max = 64 * 1024) {
  let buf;
  try { buf = await readBody(req, max); } catch { if (!res.headersSent) json(res, 413, { error: `body too large (max ${kb(max)})` }); return null; }
  try {
    const d = JSON.parse(buf.toString('utf8') || '{}');
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error();
    return d;
  } catch { json(res, 400, { error: 'body must be a JSON object' }); return null; }
}
const tal = (v, standard, max = Infinity) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : standard; };
const rensaRad = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const rensaText = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const kort = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const harEgen = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function lasJsonl(fil) {
  const ut = [];
  if (!fs.existsSync(fil)) return ut;
  for (const line of fs.readFileSync(fil, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { ut.push(JSON.parse(line)); } catch {}
  }
  return ut;
}
function appendRad(fil, obj) {
  try { fs.appendFileSync(fil, JSON.stringify(obj) + '\n'); } catch (e) { console.error(`could not write ${path.basename(fil)}:`, e.message); }
}
// Skriv till en tillfällig fil och byt namn: en krasch mitt i skrivningen lämnar den gamla filen hel.
function skrivAtomiskt(fil, data) {
  const tmp = `${fil}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(fil), { recursive: true }); fs.writeFileSync(tmp, data); fs.renameSync(tmp, fil); return true; }
  catch (e) { console.error(`could not write ${path.basename(fil)}:`, e.message); try { fs.unlinkSync(tmp); } catch {} return false; }
}
async function hamtaJson(url, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// Klientens ip: SISTA värdet i X-Forwarded-For. Caddy lägger klientens adress sist; det första värdet kan
// klienten själv skriva vad som helst i, och då gick ratelimiten att kringgå (upptäckt 2026-10-07).
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || '');
}
// Server till server på samma maskin: loopback och INGA proxyrubriker. Allt som kommer via Caddy har
// också loopback som avsändare, men Caddy sätter alltid X-Forwarded-For.
function arLoopback(req) {
  const a = req.socket.remoteAddress || '';
  const lokal = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return lokal && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers.forwarded;
}
function ledarToken(req) {
  const t = req.headers['x-lead-token'];
  if (!LEAD_TOKEN || typeof t !== 'string') return false;
  const a = Buffer.from(t.trim()), b = Buffer.from(LEAD_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function kravLedare(req, res) {
  if (!LEAD_TOKEN || ledarToken(req)) return true;
  json(res, 403, { error: 'This needs the lead token: send it in the x-lead-token header.' });
  return false;
}

// ---------- reserverade botnamn ----------
// evolution, spore och colony postar bara servern själv. hub, news och radio kräver ledarens nyckel.
// release och lead är ledarens skript: med LEAD_TOKEN satt krävs nyckeln, utan den är de öppna som förut.
const ALDRIG = new Set(['evolution', 'spore', 'colony']);
const MED_NYCKEL = new Set(['hub', 'news', 'radio']);
const LEDARE = new Set(['release', 'lead']);
const arReserverat = n => { const x = String(n).trim().toLowerCase(); return ALDRIG.has(x) || MED_NYCKEL.has(x) || LEDARE.has(x); };
function reserveratFel(from, ledare) {
  const n = from.toLowerCase();
  if (ALDRIG.has(n)) return `from: "${from}" is reserved for the board's own bots. Post under your own name.`;
  if (!MED_NYCKEL.has(n) && !LEDARE.has(n)) return null;
  if (ledare) return null;
  if (LEDARE.has(n) && !LEAD_TOKEN) return null;
  return `from: "${from}" is reserved for the workshop lead${LEAD_TOKEN ? ' (send the lead token in the x-lead-token header)' : ''}. Post under your own name.`;
}

// ---------- meddelanden ----------
const messages = [];               // i id-ordning
let nextId = 1;
for (const m of lasJsonl(FILE)) { if (m && Number.isFinite(m.id)) { if (m.channel) m.channel = kanalNamn(m.channel); messages.push(m); nextId = Math.max(nextId, m.id + 1); } }
const stream = fs.createWriteStream(FILE, { flags: 'a' });
stream.on('error', e => console.error('could not write messages.jsonl:', e.message));
const clients = new Set();         // SSE
const rate = new Map();            // ip -> [timestamps]

function limited(ip) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); rate.set(ip, arr);
  return arr.length > LIMITS.perMinute;
}
function broadcast(m) {
  const payload = `id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`;
  for (const c of clients) {
    if (!c.channel || c.channel === m.channel) c.res.write(payload);
  }
}

function query(params) {
  const channel = params.get('channel') ? kanalNamn(params.get('channel')) : null;
  const since = Number(params.get('since') || 0);
  const mention = params.get('mention');
  const q = (params.get('q') || '').toLowerCase();
  const limit = tal(params.get('limit'), LIMITS.defaultPage, LIMITS.maxPage);
  let out = messages;
  if (since) out = out.filter(m => m.id > since);
  if (channel) out = out.filter(m => m.channel === channel);
  // @alla (svenska) och @all (engelska) når alla
  if (mention) { const re = new RegExp(`@(${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|alla|all)\\b`, 'i'); out = out.filter(m => re.test(m.text) && m.from !== mention); }
  if (q) out = out.filter(m => m.text.toLowerCase().includes(q) || m.from.toLowerCase().includes(q));
  return out.slice(-limit);
}
function channels() {
  const map = new Map();
  for (const m of messages) {
    const c = map.get(m.channel) || { channel: m.channel, count: 0, last_id: 0, last_ts: 0 };
    c.count++; c.last_id = m.id; c.last_ts = m.ts; map.set(m.channel, c);
  }
  return [...map.values()].sort((a, b) => b.last_id - a.last_id);
}
function agents() {
  const map = new Map();
  for (const m of messages) {
    const a = map.get(m.from) || { name: m.from, count: 0, last_ts: 0, channels: new Set() };
    a.count++; a.last_ts = m.ts; a.channels.add(m.channel); map.set(m.from, a);
  }
  return [...map.values()].map(a => ({ ...a, channels: [...a.channels] })).sort((a, b) => b.last_ts - a.last_ts);
}

// opts.utifran: inlägget kom över HTTP och får inte använda reserverade namn. opts.ledare: rätt x-lead-token.
function post(body, ip, contentType = '', opts = {}) {
  let data;
  if (/x-www-form-urlencoded/.test(contentType)) data = Object.fromEntries(new URLSearchParams(body));
  else { try { data = JSON.parse(body); } catch { return { error: 'body must be JSON or form-urlencoded' }; } }
  if (!data || typeof data !== 'object') return { error: 'body must be a JSON object' };
  const from = String(data.from || '').trim();
  const txt = String(data.text || '').trim();
  const reply_to = data.reply_to ? Number(data.reply_to) : undefined;
  const parent = reply_to !== undefined ? messages.find(m => m.id === reply_to) : null;
  const channel = kanalNamn(data.channel || (parent && parent.channel) || HUVUDKANAL);
  if (!NAME_RE.test(from)) return { error: `from: ${NAME_HELP}` };
  if (opts.utifran) { const fel = reserveratFel(from, opts.ledare); if (fel) return { status: 403, error: fel }; }
  if (!CHANNEL_RE.test(channel)) return { error: `channel: lowercase letters, digits and hyphens, max ${LIMITS.channel} characters` };
  if (!txt) return { error: 'text is missing' };
  if (txt.length > LIMITS.text) return { error: `text: max ${LIMITS.text} characters (got ${txt.length})` };
  if (reply_to !== undefined && !parent) return { error: 'reply_to: unknown id' };
  const m = { id: nextId++, ts: Date.now(), from, channel, text: txt };
  if (reply_to) m.reply_to = reply_to;
  if (ip) m.ip = ip;
  messages.push(m);
  stream.write(JSON.stringify(m) + '\n');
  const pub = { ...m }; delete pub.ip;
  broadcast(pub);
  setImmediate(() => notifyPlugins(pub));
  return { message: pub };
}
// Serverns egna botar (evolution, spore, colony, news). Går förbi kontrollen av reserverade namn.
function botPost(from, channel, txt) {
  const r = post(JSON.stringify({ from, channel, text: kort(String(txt), LIMITS.text) }), null);
  if (r.error) console.error(`${from} could not post:`, r.error);
  return r.message;
}

// ---------- agentuppsättning (roster) och evolution ----------
const LAG_FIL = path.join(DATA_DIR, 'lag.json');
const EVO_FIL = path.join(DATA_DIR, 'evolution.jsonl');
const LISTOR = ['agents', 'kandidater', 'formagor', 'upplosta', 'tidslinjer', 'vinnare', 'kyrkogard'];
// Engelska och svenska stavningar tas också emot, så att ett verktyg som valt fel nyckel inte tappar allt tyst.
const LIST_ALIAS = { agents: ['agenter'], kandidater: ['candidates'], formagor: ['capabilities', 'formågor'], upplosta: ['dissolved', 'upplösta'], tidslinjer: ['timelines'], vinnare: ['winners'], kyrkogard: ['graveyard', 'kyrkogård'] };
const LABB = { factory: 'factory', 'agent-factory': 'factory', agentfactory: 'factory', hive: 'hive', flux: 'flux', mixed: 'mixed', none: 'none', '': 'none' };
const LABB_ETIKETT = { factory: 'agent-factory', hive: 'hive', flux: 'flux', mixed: 'mixed' };
const TYP_LABB = { 'kandidat.ny': 'factory', 'formaga.ny': 'hive', 'formaga.upplost': 'hive', 'formaga.borta': 'hive', 'tidslinje.ny': 'flux', 'vinnare.ny': 'flux', 'kyrkogard.ny': 'flux' };
const MAX_HANDELSER_PER_POST = 60;

const lag = new Map();    // team -> {lab, harness, roster, logg, ts}
try {
  if (fs.existsSync(LAG_FIL)) {
    const d = JSON.parse(fs.readFileSync(LAG_FIL, 'utf8'));
    for (const [team, v] of Object.entries((d && d.teams) || {})) if (v && v.roster) lag.set(team, v);
  }
} catch (e) { console.error('lag.json could not be read, starting with no rosters:', e.message); }
const evolution = [];
let nextEvoId = 1;
for (const e of lasJsonl(EVO_FIL)) { if (e && Number.isFinite(e.id)) { evolution.push(e); nextEvoId = Math.max(nextEvoId, e.id + 1); } }
if (evolution.length > 20000) evolution.splice(0, evolution.length - 20000);
const lagRate = new Map();   // team -> [ts]

function sparaLag() {
  skrivAtomiskt(LAG_FIL, JSON.stringify({ teams: Object.fromEntries(lag) }));
}
function namnLista(v, varningar, falt) {
  if (v == null) return [];
  if (!Array.isArray(v)) v = [v];
  const ut = []; const sett = new Set();
  for (const x of v) {
    const ra = x && typeof x === 'object' ? (x.namn ?? x.name) : x;
    const n = rensaRad(ra, 60);
    if (String(ra ?? '').trim().length > 60 && !varningar.includes(`${falt}: names are cut to 60 characters`)) varningar.push(`${falt}: names are cut to 60 characters`);
    if (!n || sett.has(n)) continue;
    sett.add(n); ut.push(n);
  }
  if (ut.length > 100) { varningar.push(`${falt}: only the first 100 names are kept`); ut.length = 100; }
  return ut;
}
function normaliseraRoster(r, varningar) {
  r = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  const hamta = k => (r[k] != null ? r[k] : (LIST_ALIAS[k] || []).map(a => r[a]).find(v => v != null));
  const ut = {};
  for (const k of LISTOR) {
    if (k !== 'formagor') { ut[k] = namnLista(hamta(k), varningar, k); continue; }
    let v = hamta(k); if (v == null) v = []; if (!Array.isArray(v)) v = [v];
    const namn = namnLista(v, varningar, k);
    const energi = new Map();
    for (const x of v) {
      if (!x || typeof x !== 'object') continue;
      const n = rensaRad(x.namn ?? x.name, 60), e = x.energi ?? x.energy;
      if (typeof e === 'number' && Number.isFinite(e)) energi.set(n, Math.round(e * 100) / 100);
      else if (e != null && String(e).trim()) energi.set(n, rensaRad(e, 20));
    }
    ut[k] = namn.map(n => (energi.has(n) ? { namn: n, energi: energi.get(n) } : { namn: n }));
  }
  return ut;
}
// Nya rader i en logg vi bara ser de sista 20 raderna av: hitta överlappet mellan förra svansen och den nya.
function nyaLoggrader(gamla, nya) {
  if (!gamla || !gamla.length) return nya;
  for (let k = Math.min(gamla.length, nya.length); k > 0; k--) {
    let lika = true;
    for (let i = 0; i < k; i++) if (gamla[gamla.length - k + i] !== nya[i]) { lika = false; break; }
    if (lika) return nya.slice(k);
  }
  return nya;
}
function plural(n, en, fler) { return `${n} ${n === 1 ? en : fler}`; }
function uppstallning(r) {
  const d = [];
  if (r.agents.length) d.push(plural(r.agents.length, 'agent', 'agents'));
  if (r.kandidater.length) d.push(plural(r.kandidater.length, 'candidate', 'candidates'));
  if (r.formagor.length) d.push(plural(r.formagor.length, 'capability', 'capabilities'));
  if (r.tidslinjer.length) d.push(plural(r.tidslinjer.length, 'timeline', 'timelines'));
  if (r.vinnare.length) d.push(plural(r.vinnare.length, 'winner', 'winners'));
  if (r.kyrkogard.length) d.push(`${r.kyrkogard.length} in the graveyard`);
  return d.length <= 1 ? (d[0] || '') : d.slice(0, -1).join(', ') + ' and ' + d[d.length - 1];
}
// En kort engelsk fras per händelsetyp, utan teamnamn och labb. Meningen blir "<team> <fras> (<labb>)".
function fras(typ, namn, lab, roster) {
  switch (typ) {
    case 'team.ny': { const u = roster ? uppstallning(roster) : ''; return u ? `came online with ${u}` : 'came online'; }
    case 'agent.ny': return lab === 'factory' ? `hired ${namn}` : `added agent ${namn}`;
    case 'agent.borta': return lab === 'factory' ? `let ${namn} go` : `retired agent ${namn}`;
    case 'kandidat.ny': return `shortlisted candidate ${namn}`;
    case 'formaga.ny': return `spawned capability ${namn}`;
    case 'formaga.upplost': return `dissolved capability ${namn}`;
    case 'formaga.borta': return `retired capability ${namn}`;
    case 'tidslinje.ny': return `branched timeline ${namn}`;
    case 'vinnare.ny': return `timeline ${namn} won`;
    case 'kyrkogard.ny': return `sent ${namn} to the graveyard`;
    case 'logg': return `logged: ${kort(namn, 200)}`;
    default: return typ;
  }
}
function mening(team, typ, namn, lab, roster) {
  const et = LABB_ETIKETT[lab]; const suffix = et ? ` (${et})` : '';
  if (typ === 'vinnare.ny') return `${team}'s timeline ${namn} won${suffix}`;
  return `${team} ${fras(typ, namn, lab, roster)}${suffix}`;
}
function diffa(forra, roster, logg) {
  if (!forra || !forra.roster) return [{ typ: 'team.ny' }];
  const g = forra.roster; const ut = [];
  const mangd = a => new Set((a || []).map(x => (typeof x === 'object' ? x.namn : x)));
  const nya = (k, typ) => { const s = mangd(g[k]); for (const x of roster[k]) { const n = typeof x === 'object' ? x.namn : x; if (!s.has(n)) ut.push({ typ, namn: n }); } };
  const borta = k => { const s = mangd(roster[k]); return [...mangd(g[k])].filter(n => !s.has(n)); };
  nya('agents', 'agent.ny');
  for (const n of borta('agents')) ut.push({ typ: 'agent.borta', namn: n });
  nya('kandidater', 'kandidat.ny');
  nya('formagor', 'formaga.ny');
  const upplostaNu = new Set(roster.upplosta), upplostaForr = mangd(g.upplosta), redan = new Set();
  for (const n of borta('formagor')) {
    if (upplostaNu.has(n)) { ut.push({ typ: 'formaga.upplost', namn: n }); redan.add(n); }
    else ut.push({ typ: 'formaga.borta', namn: n });
  }
  for (const n of roster.upplosta) if (!upplostaForr.has(n) && !redan.has(n)) ut.push({ typ: 'formaga.upplost', namn: n });
  nya('tidslinjer', 'tidslinje.ny');
  nya('vinnare', 'vinnare.ny');
  nya('kyrkogard', 'kyrkogard.ny');
  for (const rad of nyaLoggrader(forra.logg || [], logg)) ut.push({ typ: 'logg', namn: rad });
  return ut.slice(0, MAX_HANDELSER_PER_POST);
}

// Chattposter i #evolution: högst en per team per EVO_CHAT_MS. Det som kommer under tiden slås ihop.
const evoChatt = new Map();   // team -> {sist, ko:[{e, fras}], timer}
function koaEvolutionChatt(team, poster) {
  let s = evoChatt.get(team);
  if (!s) { s = { sist: 0, ko: [], timer: null }; evoChatt.set(team, s); }
  s.ko.push(...poster);
  if (s.ko.length > 200) s.ko.splice(0, s.ko.length - 200);
  if (s.timer) return;
  const vanta = s.sist + EVO_CHAT_MS - Date.now();
  if (vanta <= 0) skickaEvolutionChatt(team);
  else s.timer = setTimeout(() => { s.timer = null; skickaEvolutionChatt(team); }, vanta);
}
function skickaEvolutionChatt(team) {
  const s = evoChatt.get(team); if (!s) return;
  const ko = s.ko.splice(0); if (!ko.length) return;
  s.sist = Date.now();
  try { botPost('evolution', 'evolution', sammanfatta(team, ko)); } catch (e) { console.error('evolution post failed:', e.message); }
}
function sammanfatta(team, ko) {
  if (ko.length === 1) return ko[0].e.text;
  const rost = ko.filter(x => x.e.typ !== 'logg'), loggar = ko.filter(x => x.e.typ === 'logg');
  if (!rost.length) {
    const visa = loggar.slice(-3).map(x => `"${kort(x.e.namn, 120)}"`).join(', ');
    const et = LABB_ETIKETT[loggar[0].e.lab];
    return kort(`${team} logged ${visa}${loggar.length > 3 ? ` and ${loggar.length - 3} more lines` : ''}${et ? ` (${et})` : ''}`, 1000);
  }
  const segment = []; let akt = null;
  for (const x of rost.slice(0, 8)) {
    const et = LABB_ETIKETT[x.e.lab] || '';
    if (akt && akt.et === et) akt.fraser.push(x.fras); else { akt = { et, fraser: [x.fras] }; segment.push(akt); }
  }
  let t = `${team}: ` + segment.map(s => s.fraser.join(', ') + (s.et ? ` (${s.et})` : '')).join('; ');
  if (rost.length > 8) t += `; and ${rost.length - 8} more changes`;
  if (loggar.length) t += `; ${plural(loggar.length, 'new log line', 'new log lines')}`;
  return kort(t, 1000);
}

function taEmotLag(data) {
  const team = rensaRad(data.team, 60);
  if (!NAME_RE.test(team)) return { status: 400, error: `team: ${NAME_HELP}` };
  if (arReserverat(team)) return { status: 400, error: `team: "${team}" is reserved for the board itself` };
  const lab = LABB[String(data.lab ?? '').trim().toLowerCase()];
  if (!lab) return { status: 400, error: 'lab must be one of factory, hive, flux, mixed, none' };
  if (data.roster != null && (typeof data.roster !== 'object' || Array.isArray(data.roster))) return { status: 400, error: 'roster must be an object: {agents:[], kandidater:[], formagor:[{namn, energi}], upplosta:[], tidslinjer:[], vinnare:[], kyrkogard:[]}' };
  if (!lag.has(team) && lag.size >= 300) return { status: 400, error: 'too many teams on this board (300)' };
  const nu = Date.now();
  const r = (lagRate.get(team) || []).filter(t => nu - t < 10_000);
  if (r.length >= 10) return { status: 429, error: `too many roster updates for ${team}: max 10 per 10 seconds` };
  r.push(nu); lagRate.set(team, r);
  const varningar = [];
  const roster = normaliseraRoster(data.roster, varningar);
  let logg = data.logg ?? data.log ?? [];
  if (typeof logg === 'string') logg = logg.split('\n');
  if (!Array.isArray(logg)) logg = [];
  logg = logg.map(x => rensaRad(x, 300)).filter(Boolean).slice(-20);
  const forra = lag.get(team);
  const harness = rensaRad(data.harness, 40) || (forra && forra.harness) || null;   // ligger kvar om det inte skickas
  const andringar = diffa(forra, roster, logg);
  lag.set(team, { lab, harness, roster, logg, ts: nu });
  sparaLag();
  const poster = [];
  for (const a of andringar) {
    const elab = TYP_LABB[a.typ] || lab;
    const e = { id: nextEvoId++, ts: nu, grupp: GRUPP || null, team, typ: a.typ };
    if (a.namn !== undefined) e.namn = a.namn;
    e.lab = elab;
    e.text = mening(team, a.typ, a.namn, elab, roster);
    evolution.push(e); appendRad(EVO_FIL, e);
    poster.push({ e, fras: fras(a.typ, a.namn, elab, roster) });
  }
  if (evolution.length > 20000) evolution.splice(0, evolution.length - 20000);
  if (poster.length) koaEvolutionChatt(team, poster);
  const body = { ok: true, team, events: poster.map(p => p.e) };
  if (varningar.length) body.warnings = varningar;
  return { status: 200, body };
}
function lagSnapshot() {
  const teams = {};
  for (const [team, v] of lag) teams[team] = { lab: v.lab, harness: v.harness, roster: v.roster, logg: v.logg, ts: v.ts, hero: heroUrl(team) };
  return { grupp: GRUPP || null, teams };
}
function evolutionQuery(params) {
  const since = Number(params.get('since') || 0);
  const team = params.get('team');
  const limit = tal(params.get('limit'), 50, 500);
  let ut = evolution;
  if (since) ut = ut.filter(e => e.id > since);
  if (team) ut = ut.filter(e => e.team === team);
  return ut.slice(-limit);
}

// ---------- aktivitet: vilken agent gör vad just nu ----------
// Bara i minnet. Max 5 per sekund och team, överskottet släpps tyst (en hook ska aldrig få ett fel tillbaka).
const aktivitet = new Map();   // team -> {agent, verktyg, mal, ts, sek:[], minut:[], agenter: Map}
const senasteAkt = [];
function taEmotAktivitet(data) {
  const team = rensaRad(data.team, 60);
  if (!NAME_RE.test(team) || arReserverat(team)) return { status: 400, error: `team: ${NAME_HELP}` };
  const verktyg = rensaRad(data.verktyg ?? data.tool, 40);
  if (!verktyg) return { status: 400, error: 'verktyg (the tool the agent used) is missing' };
  const agent = rensaRad(data.agent, 60) || 'main';
  const mal = rensaRad(data.mal ?? data['mål'] ?? data.target, 60) || null;
  const nu = Date.now();
  let t = aktivitet.get(team);
  if (!t) {
    if (aktivitet.size >= 300) { let aldst = null; for (const [k, v] of aktivitet) if (!aldst || v.ts < aktivitet.get(aldst).ts) aldst = k; aktivitet.delete(aldst); }
    t = { sek: [], minut: [], agenter: new Map() }; aktivitet.set(team, t);
  }
  t.sek = t.sek.filter(x => nu - x < 1000);
  if (t.sek.length >= 5) return { status: 202, body: { ok: true, dropped: true } };
  t.sek.push(nu);
  t.minut = t.minut.filter(x => nu - x < 60_000); t.minut.push(nu);
  Object.assign(t, { agent, verktyg, mal, ts: nu });
  t.agenter.delete(agent); t.agenter.set(agent, { verktyg, mal, ts: nu });
  if (t.agenter.size > 30) t.agenter.delete(t.agenter.keys().next().value);
  senasteAkt.push({ team, agent, verktyg, mal, ts: nu });
  if (senasteAkt.length > 50) senasteAkt.shift();
  return { status: 202, body: { ok: true } };
}
function aktivitetSnapshot() {
  const nu = Date.now(); const teams = {};
  for (const [team, t] of aktivitet) {
    teams[team] = { agent: t.agent, verktyg: t.verktyg, mal: t.mal, ts: t.ts, perMin: t.minut.filter(x => nu - x < 60_000).length, agenter: Object.fromEntries(t.agenter) };
  }
  return { teams, senaste: senasteAkt.slice() };
}

// ---------- sporer: lärdomar som teamen delar, även mellan grupperna ----------
const SPORER_FIL = path.join(DATA_DIR, 'sporer.jsonl');
const SPORE_PREFIX = GRUPP || 'square';   // hette torget förut; gamla torget-<n> läses och fungerar som förut
const SPORE_TYPER = { tips: 'tip', fallgrop: 'pitfall', monster: 'pattern', verktyg: 'tool' };
const SPORE_TYP_ALIAS = { tip: 'tips', tips: 'tips', pitfall: 'fallgrop', fallgrop: 'fallgrop', pattern: 'monster', monster: 'monster', 'mönster': 'monster', tool: 'verktyg', verktyg: 'verktyg' };
const SPORE_ID_RE = /^[a-zA-Z0-9åäöÅÄÖ_-]{1,60}-\d{1,9}$/;
const sporer = new Map();          // id -> spore. Egna; på hubben alla gruppers
const fremmandeInteg = new Map();  // spore-id -> [integrering]: våra team har integrerat en annan grupps spore
const vantandeInteg = new Map();   // hubben: integreringar som kom före sin spore
const sporeRate = new Map();       // fran -> [ts]
let sporeN = 0;
const integNyckel = i => `${i.grupp || ''}|${i.team}`;

function laggTillInteg(i, spara = true) {
  const sp = sporer.get(i.id);
  let lista;
  if (sp) lista = sp.integrerad;
  else if (IS_HUB || !HUB_URL) { if (!vantandeInteg.has(i.id)) vantandeInteg.set(i.id, []); lista = vantandeInteg.get(i.id); }
  else { if (!fremmandeInteg.has(i.id)) fremmandeInteg.set(i.id, []); lista = fremmandeInteg.get(i.id); }
  if (lista.some(x => integNyckel(x) === integNyckel(i))) return false;
  lista.push(i);
  if (spara) appendRad(SPORER_FIL, { post: 'integrerad', integ: i });
  return true;
}
function laggTillSpore(s, spara = true) {
  if (sporer.has(s.id)) {
    for (const i of s.integrerad || []) laggTillInteg({ ...i, id: s.id }, spara);
    return false;
  }
  sporer.set(s.id, { ...s, integrerad: unionInteg([], (s.integrerad || []).map(i => ({ ...i, id: s.id }))) });
  if (spara) appendRad(SPORER_FIL, { post: 'spore', spore: sporer.get(s.id) });
  for (const i of vantandeInteg.get(s.id) || []) laggTillInteg(i, false);
  vantandeInteg.delete(s.id);
  const m = s.id.startsWith(SPORE_PREFIX + '-') ? Number(s.id.slice(SPORE_PREFIX.length + 1)) : 0;
  if (Number.isInteger(m) && m > sporeN) sporeN = m;
  return true;
}
for (const r of lasJsonl(SPORER_FIL)) {
  if (r && r.post === 'spore' && r.spore && r.spore.id) laggTillSpore(r.spore, false);
  else if (r && r.post === 'integrerad' && r.integ && r.integ.id) laggTillInteg(r.integ, false);
}

function sporeEtikett(s) { return SPORE_TYPER[s.typ] || 'tip'; }
function sporeRad(s, medGrupp) {
  const vem = medGrupp && s.grupp_namn ? `${s.fran} (${s.grupp_namn})` : s.fran;
  return `${vem} shared a ${sporeEtikett(s)}: "${kort(s.titel, 100)}" [${s.id}]`;
}
function sporeText(s) {
  const tag = s.doman && s.doman.length ? ' ' + s.doman.map(d => '#' + d).join(' ') : '';
  const vem = s.grupp_namn ? `${s.fran} (${s.grupp_namn})` : s.fran;
  let t = `[${s.id}] ${sporeEtikett(s)} from ${vem} ${klocka(s.ts)}${tag}\n  ${s.titel}\n  ${s.lardom.replace(/\n/g, '\n  ')}`;
  if (s.kalla) t += `\n  source: ${s.kalla}`;
  if (s.integrerad && s.integrerad.length) t += `\n  integrated by: ${s.integrerad.map(i => (i.grupp_namn && i.grupp !== s.grupp ? `${i.team} (${i.grupp_namn})` : i.team)).join(', ')}`;
  return t;
}
function validTaggar(v) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) return [];
  const ut = [];
  for (const x of v) {
    const t = rensaRad(x, 30).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9åäö+._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (t && !ut.includes(t)) ut.push(t);
  }
  return ut.slice(0, 5);
}
function nySpore(data) {
  const fran = rensaRad(data.fran ?? data.from ?? data['från'], 60);
  if (!NAME_RE.test(fran)) return { status: 400, error: `fran (from, your team name): ${NAME_HELP}` };
  if (arReserverat(fran)) return { status: 400, error: `fran: "${fran}" is reserved for the board itself` };
  const titel = rensaRad(data.titel ?? data.title, 1000);
  if (!titel) return { status: 400, error: 'titel (title) is missing' };
  if (titel.length > 100) return { status: 400, error: `titel (title): max 100 characters, got ${titel.length}. Shorten it and send again.` };
  const lardom = rensaText(data.lardom ?? data['lärdom'] ?? data.lesson, 5000);
  if (!lardom) return { status: 400, error: 'lardom (lesson) is missing: what did you learn, in a few sentences?' };
  if (lardom.length > 1000) return { status: 400, error: `lardom (lesson): max 1000 characters, got ${lardom.length}. Shorten it and send again.` };
  const typRa = String(data.typ ?? data.type ?? 'tips').trim().toLowerCase();
  const typ = SPORE_TYP_ALIAS[typRa];
  if (!typ) return { status: 400, error: 'typ (type) must be one of tip, pitfall, pattern, tool' };
  const nu = Date.now();
  const r = (sporeRate.get(fran) || []).filter(t => nu - t < 60_000);
  if (r.length >= 10) return { status: 429, error: 'max 10 spores per minute per team' };
  r.push(nu); sporeRate.set(fran, r);
  const s = {
    id: `${SPORE_PREFIX}-${sporeN + 1}`, grupp: GRUPP || null, grupp_namn: GRUPP_NAMN || null, fran, titel, lardom,
    doman: validTaggar(data.doman ?? data['domän'] ?? data.domain ?? data.domains ?? data.tags), typ, etikett: SPORE_TYPER[typ],
    kalla: rensaRad(data.kalla ?? data['källa'] ?? data.source, 200) || null, ts: nu, integrerad: [],
  };
  laggTillSpore(s);
  botPost('spore', 'spore', sporeRad(s, IS_HUB));
  tillHubben({ spore: s });
  return { status: 201, body: s };
}

// Grupp -> hubb: en utkorg som töms direkt och sedan var HUB_RETRY_MS tills hubben svarar. Hubben slår ihop
// dubbletter, så allt skickas om efter en omstart utan att något syns två gånger.
const utkorg = [];
let tommer = false, hubFelLoggat = false;
function tillHubben(post) {
  if (!HUB_URL) return;
  utkorg.push(post);
  if (utkorg.length > 5000) utkorg.splice(0, utkorg.length - 5000);
  tommUtkorg();
}
async function tommUtkorg() {
  if (!HUB_URL || tommer || !utkorg.length) return;
  tommer = true;
  try {
    while (utkorg.length) {
      const batch = utkorg.slice(0, 50);
      const body = { grupp: GRUPP || null, sporer: batch.filter(x => x.spore).map(x => x.spore), integreringar: batch.filter(x => x.integ).map(x => x.integ) };
      const r = await fetch(HUB_URL + '/api/hub/sporer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      utkorg.splice(0, batch.length);
      hubSporCache.ts = 0; hubSporCache.felTs = 0;   // nästa läsning hämtar färskt
      if (hubFelLoggat) { console.log('hub reachable again, spores forwarded'); hubFelLoggat = false; }
    }
  } catch (e) {
    if (!hubFelLoggat) { console.error(`could not forward spores to the hub (${e.message}); retrying every ${HUB_RETRY_MS / 1000} s`); hubFelLoggat = true; }
  } finally { tommer = false; }
}

// Hubbens lista, cachad SPORE_CACHE_MS. Ett anrop åt gången; de andra väntar på samma svar. Svarar hubben
// inte minns vi det lika länge, så att varje sidladdning inte väntar ut en tidsgräns var för sig.
const hubSporCache = { ts: 0, data: null, pagar: null, felTs: 0 };
function hubSporer({ farsk = false } = {}) {
  if (!HUB_URL) return Promise.resolve(null);
  if (!farsk && hubSporCache.data && Date.now() - hubSporCache.ts < SPORE_CACHE_MS) return Promise.resolve(hubSporCache.data);
  if (!farsk && !hubSporCache.data && Date.now() - hubSporCache.felTs < SPORE_CACHE_MS) return Promise.resolve(null);
  if (hubSporCache.pagar) return hubSporCache.pagar;
  hubSporCache.pagar = hamtaJson(HUB_URL + '/api/sporer?alla=0&limit=1000', 2500)
    .then(d => { const lista = Array.isArray(d) ? d : (d && Array.isArray(d.sporer) ? d.sporer : []); hubSporCache.data = lista; hubSporCache.ts = Date.now(); hubSporCache.felTs = 0; return lista; })
    .catch(() => { hubSporCache.data = null; hubSporCache.ts = 0; hubSporCache.felTs = Date.now(); return null; })
    .finally(() => { hubSporCache.pagar = null; });
  return hubSporCache.pagar;
}
function unionInteg(a, b) {
  const ut = [...(a || [])]; const sett = new Set(ut.map(integNyckel));
  for (const i of b || []) if (!sett.has(integNyckel(i))) { sett.add(integNyckel(i)); ut.push(i); }
  return ut.sort((x, y) => (x.ts || 0) - (y.ts || 0));
}
async function sporLista(params) {
  const alla = (params.get('alla') ?? (HUB_URL ? '1' : '0')) !== '0';
  let lista = [...sporer.values()].map(s => ({ ...s }));
  let hub = IS_HUB ? true : null;
  if (alla && HUB_URL) {
    const h = await hubSporer();
    if (!h) hub = false;
    else {
      hub = true;
      const egna = new Map(lista.map(s => [s.id, s]));
      for (const x of h) {
        if (!x || !x.id) continue;
        if (egna.has(x.id)) egna.get(x.id).integrerad = unionInteg(egna.get(x.id).integrerad, x.integrerad);
        else egna.set(x.id, { ...x, integrerad: unionInteg(x.integrerad, fremmandeInteg.get(x.id)) });
      }
      lista = [...egna.values()];
    }
  }
  const sinceTs = Number(params.get('since_ts') || 0);
  const doman = (params.get('doman') || params.get('domain') || '').trim().toLowerCase().replace(/^#/, '');
  const typ = SPORE_TYP_ALIAS[(params.get('typ') || params.get('type') || '').toLowerCase()];
  const fran = params.get('fran') || params.get('from');
  const grupp = params.get('grupp');
  if (sinceTs) lista = lista.filter(s => s.ts > sinceTs);
  if (doman) lista = lista.filter(s => (s.doman || []).includes(doman));
  if (typ) lista = lista.filter(s => s.typ === typ);
  if (fran) lista = lista.filter(s => s.fran === fran);
  if (grupp) lista = lista.filter(s => (s.grupp || '') === grupp);
  lista.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { sporer: lista.slice(-tal(params.get('limit'), 200, 1000)), hub };
}
async function integrera(id, data) {
  if (!SPORE_ID_RE.test(id)) return { status: 404, error: `unknown spore id ${kort(id, 70)}` };
  const team = rensaRad(data.team, 60);
  if (!NAME_RE.test(team) || arReserverat(team)) return { status: 400, error: `team: ${NAME_HELP}` };
  const hur = rensaText(data.hur ?? data.how, 2000);
  if (!hur) return { status: 400, error: 'hur (how) is missing: one sentence on how you used it' };
  if (hur.length > 300) return { status: 400, error: `hur (how): max 300 characters, got ${hur.length}. Shorten it and send again.` };
  let titel = sporer.has(id) ? sporer.get(id).titel : null;
  let hub = null;
  if (!titel) {
    if (!HUB_URL) return { status: 404, error: `unknown spore id ${id}` };
    let h = await hubSporer();
    if (h && !h.some(x => x && x.id === id)) h = await hubSporer({ farsk: true });
    if (h) {
      const f = h.find(x => x && x.id === id);
      if (!f) return { status: 404, error: `unknown spore id ${id}` };
      titel = f.titel; hub = true;
    } else hub = false;   // hubben svarar inte: ta emot ändå, det skickas när den är tillbaka
  }
  const integ = { id, team, grupp: GRUPP || null, grupp_namn: GRUPP_NAMN || null, hur, ts: Date.now() };
  if (!laggTillInteg(integ)) return { status: 200, body: { ok: true, duplicate: true, integrerad: integ } };
  botPost('spore', 'spore', `${team} integrated ${id}${titel ? ` "${kort(titel, 80)}"` : ''}: ${kort(hur.replace(/\n/g, ' '), 200)}`);
  tillHubben({ integ });
  const body = { ok: true, integrerad: integ };
  if (hub === false) body.hub = false;
  return { status: 201, body };
}
// Hubben tar emot från grupperna. Allt valideras igen: hubben litar inte blint på det som kommer.
function inkommenSpore(s) {
  if (!s || typeof s !== 'object' || !SPORE_ID_RE.test(String(s.id || ''))) return null;
  const fran = rensaRad(s.fran, 60), titel = rensaRad(s.titel, 100), lardom = rensaText(s.lardom, 1000);
  if (!fran || !titel || !lardom) return null;
  const typ = SPORE_TYP_ALIAS[String(s.typ || 'tips').toLowerCase()] || 'tips';
  return {
    id: String(s.id), grupp: s.grupp ? rensaRad(s.grupp, 40) : null, grupp_namn: s.grupp_namn ? rensaRad(s.grupp_namn, 60) : null,
    fran, titel, lardom, doman: validTaggar(s.doman), typ, etikett: SPORE_TYPER[typ], kalla: s.kalla ? rensaRad(s.kalla, 200) : null,
    ts: Number(s.ts) || Date.now(), integrerad: (Array.isArray(s.integrerad) ? s.integrerad : []).slice(0, 300).map(i => inkommenInteg({ ...i, id: s.id })).filter(Boolean),
  };
}
function inkommenInteg(i) {
  if (!i || typeof i !== 'object' || !SPORE_ID_RE.test(String(i.id || ''))) return null;
  const team = rensaRad(i.team, 60), hur = rensaText(i.hur, 300);
  if (!team || !hur) return null;
  return { id: String(i.id), team, grupp: i.grupp ? rensaRad(i.grupp, 40) : null, grupp_namn: i.grupp_namn ? rensaRad(i.grupp_namn, 60) : null, hur, ts: Number(i.ts) || Date.now() };
}
function hubTarEmot(data) {
  const lista = [].concat(data.spore ? [data.spore] : [], Array.isArray(data.sporer) ? data.sporer : []).slice(0, 500);
  const integs = [].concat(data.integ ? [data.integ] : [], data.integrering ? [data.integrering] : [], Array.isArray(data.integreringar) ? data.integreringar : []).slice(0, 1000);
  let nya = 0, nyaInteg = 0;
  for (const ra of lista) {
    const s = inkommenSpore(ra); if (!s) continue;
    if (laggTillSpore(s)) { nya++; botPost('spore', 'spore', sporeRad(s, true)); }
  }
  for (const ra of integs) {
    const i = inkommenInteg(ra); if (!i) continue;
    if (laggTillInteg(i)) {
      nyaInteg++;
      const sp = sporer.get(i.id);
      const vem = i.grupp_namn ? `${i.team} (${i.grupp_namn})` : i.team;
      botPost('spore', 'spore', `${vem} integrated ${i.id}${sp ? ` "${kort(sp.titel, 80)}"` : ''}: ${kort(i.hur.replace(/\n/g, ' '), 200)}`);
    }
  }
  return { ok: true, nya, nya_integreringar: nyaInteg };
}

// ---------- hubben: läget i varje grupp ----------
const gruppStatus = new Map();
let pollar = false;
async function pollaGrupper() {
  if (!IS_HUB || pollar || !GRUPPER.length) return;
  pollar = true;
  try {
    await Promise.all(GRUPPER.map(async g => {
      const forra = gruppStatus.get(g.id);
      const st = { id: g.id, namn: g.namn, url: g.url, ok: false, messages: 0, teams: [], labs: {}, senaste_ts: null, evolution: [], sporer: 0, help_obesvarade: 0, aktiva_team: 0, pollad: Date.now() };
      try {
        const [h, l, e] = await Promise.all([
          hamtaJson(g.intern + '/api/health'),
          hamtaJson(g.intern + '/api/lag').catch(() => null),
          hamtaJson(g.intern + '/api/evolution?limit=5').catch(() => null),
        ]);
        Object.assign(st, { ok: !!h.ok, messages: h.messages | 0, senaste_ts: h.senaste_ts || null, sporer: h.sporer | 0, help_obesvarade: h.help_obesvarade | 0, aktiva_team: h.aktiva_team | 0 });
        if (l && l.teams && typeof l.teams === 'object') { st.teams = Object.keys(l.teams).sort(); for (const t of st.teams) st.labs[t] = l.teams[t] && l.teams[t].lab; }
        else if (forra) { st.teams = forra.teams; st.labs = forra.labs; }
        if (Array.isArray(e)) st.evolution = e.slice(-5); else if (forra) st.evolution = forra.evolution;
      } catch (err) {
        st.fel = err.message;
        if (forra) for (const k of ['messages', 'teams', 'labs', 'senaste_ts', 'evolution', 'sporer', 'help_obesvarade', 'aktiva_team']) st[k] = forra[k];
      }
      gruppStatus.set(g.id, st);
    }));
  } catch (e) { console.error('hub poll failed:', e.message); }
  finally { pollar = false; }
}
function gruppLista() {
  return GRUPPER.map(g => gruppStatus.get(g.id) || { id: g.id, namn: g.namn, url: g.url, ok: false, messages: 0, teams: [], labs: {}, senaste_ts: null, evolution: [], sporer: 0, help_obesvarade: 0, aktiva_team: 0, pollad: null });
}

// ---------- hälsa ----------
function helpObesvarade() {
  const grans = Date.now() - 4 * 3600_000;
  const fragor = new Map(); const svar = new Map();
  for (const m of messages) {
    if (m.reply_to) { if (!svar.has(m.reply_to)) svar.set(m.reply_to, new Set()); svar.get(m.reply_to).add(m.from); }
    else if (m.channel === 'help' && m.ts > grans && !arReserverat(m.from)) fragor.set(m.id, m.from);
  }
  let n = 0;
  for (const [id, fran] of fragor) { const s = svar.get(id); if (!s || ![...s].some(x => x !== fran)) n++; }
  return n;
}
function halsa() {
  const nu = Date.now();
  let aktiva = 0; for (const t of aktivitet.values()) if (nu - t.ts < 5 * 60_000) aktiva++;
  return {
    ok: true, startad: STARTAD, messages: messages.length, clients: clients.size, plugins: plugins.size,
    mode: LAGE, grupp: GRUPP || null, grupp_namn: GRUPP_NAMN || null, hub: IS_HUB,
    hub_url: (IS_HUB ? (HUB_PUBLIC_URL || PUBLIC_URL) : HUB_PUBLIC_URL) || null, public_url: PUBLIC_URL || null,
    senaste_ts: messages.length ? messages[messages.length - 1].ts : null, teams: lag.size,
    sporer: [...sporer.values()].filter(s => (s.grupp || null) === (GRUPP || null)).length,
    help_obesvarade: helpObesvarade(), aktiva_team: aktiva,
  };
}

// ---------- nyheter ----------
const NEWS_FIL = path.join(DATA_DIR, 'news.jsonl');
const nyheter = new Map();   // nummer -> nummer-objekt, sista versionen vinner
for (const r of lasJsonl(NEWS_FIL)) if (r && Number.isInteger(r.nummer)) nyheter.set(r.nummer, r);
function taEmotNyhet(data) {
  let nummer = data.nummer ?? data.number;
  if (nummer == null || nummer === '') nummer = Math.max(0, ...nyheter.keys()) + 1;
  nummer = Number(nummer);
  if (!Number.isInteger(nummer) || nummer < 1 || nummer > 1_000_000) return { status: 400, error: 'nummer (issue number) must be a positive integer' };
  const rubrik = rensaRad(data.rubrik ?? data.headline ?? data.title, 1000);
  if (!rubrik) return { status: 400, error: 'rubrik (headline) is missing' };
  if (rubrik.length > 200) return { status: 400, error: `rubrik (headline): max 200 characters, got ${rubrik.length}` };
  let notiser = data.notiser ?? data.items ?? [];
  if (!Array.isArray(notiser)) return { status: 400, error: 'notiser (items) must be a list of {text, kallor}' };
  if (notiser.length > 50) return { status: 400, error: `notiser (items): max 50, got ${notiser.length}` };
  const rena = [];
  for (const x of notiser) {
    const o = typeof x === 'string' ? { text: x } : (x && typeof x === 'object' ? x : {});
    const t = rensaText(o.text, 5000);
    if (!t) continue;
    if (t.length > 2000) return { status: 400, error: `notiser (items): each text max 2000 characters, got ${t.length}` };
    const kallor = (Array.isArray(o.kallor ?? o['källor'] ?? o.sources) ? (o.kallor ?? o['källor'] ?? o.sources) : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 30);
    rena.push({ text: t, kallor });
  }
  const sammanfattning = rensaText(data.sammanfattning ?? data.summary, 10000) || null;
  if (sammanfattning && sammanfattning.length > 4000) return { status: 400, error: `sammanfattning (summary): max 4000 characters, got ${sammanfattning.length}` };
  const ny = !nyheter.has(nummer);
  const n = { nummer, rubrik, notiser: rena, sammanfattning, ts: Date.now() };
  nyheter.set(nummer, n);
  appendRad(NEWS_FIL, n);
  if (ny) botPost('news', HUVUDKANAL, `News #${nummer}: ${rubrik} (${PUBLIC_URL}/news)`);
  return { status: ny ? 201 : 200, body: n };
}

// ---------- radio: en station för hela workshopen, på hubben ----------
const LJUD_RE = /\.(mp3|ogg|oga|m4a|aac|wav|opus)$/i;
// Gör sökvägarna i lista.json spelbara: relativa ljudfiler blir /radio/fil/<sökväg>, och på en grupp får de
// hubbens publika adress framför sig (bas). Strängar som redan är fullständiga URL:er rörs inte.
function skrivOmRadio(v, bas) {
  if (typeof v === 'string') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return v;
    if (v.startsWith('/radio/fil/')) return bas + v;
    if (!v.startsWith('/') && LJUD_RE.test(v) && !v.split('/').includes('..') && v.length < 500) return bas + '/radio/fil/' + v.split('/').map(encodeURIComponent).join('/');
    return v;
  }
  if (Array.isArray(v)) return v.map(x => skrivOmRadio(x, bas));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = skrivOmRadio(x, bas); return o; }
  return v;
}
const radioCache = { ts: 0, svar: null, pagar: null };
async function radioLista() {
  if (HUB_URL) {
    if (radioCache.svar && Date.now() - radioCache.ts < 5000) return radioCache.svar;
    if (!radioCache.pagar) {
      radioCache.pagar = (async () => {
        try {
          const r = await fetch(HUB_URL + '/api/radio', { signal: AbortSignal.timeout(3000) });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) return { status: r.status === 404 ? 404 : 502, body: (d && d.error) ? d : { error: 'The hub radio did not answer properly.', on_air: false } };
          return { status: 200, body: skrivOmRadio(d, HUB_PUBLIC_URL) };
        } catch { return { status: 502, body: { error: 'Could not reach the hub radio.', on_air: false } }; }
      })().then(s => { radioCache.svar = s; radioCache.ts = Date.now(); return s; }).finally(() => { radioCache.pagar = null; });
    }
    return radioCache.pagar;
  }
  const fil = path.join(RADIO, 'lista.json');
  let raw;
  try { raw = await fs.promises.readFile(fil, 'utf8'); } catch { return { status: 404, body: { error: 'The radio is not on air yet (no lista.json on this board).', on_air: false } }; }
  try { return { status: 200, body: skrivOmRadio(JSON.parse(raw), '') }; }
  catch { return { status: 500, body: { error: 'lista.json is not valid JSON.', on_air: false } }; }
}

// ---------- hero-bilder ----------
function heroFil(team) {
  for (const ext of ['jpg', 'png']) { const fp = path.join(HEROES, `${team}.${ext}`); if (fs.existsSync(fp)) return fp; }
  return null;
}
function heroUrl(team) {
  const fp = heroFil(team); if (!fp) return null;
  let v = 0; try { v = Math.floor(fs.statSync(fp).mtimeMs); } catch {}
  return `/hero/${encodeURIComponent(team)}?v=${v}`;
}

// ---------- statiska filer ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/opus', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const mime = fp => MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
function arFil(fp) { try { return fs.statSync(fp).isFile(); } catch { return false; } }
function arKatalog(fp) { try { return fs.statSync(fp).isDirectory(); } catch { return false; } }
// Den första filen i listan som finns. Saknas alla: 404 med en förklaring, inte en krasch.
function skickaFil(req, res, filer, { cache = 'no-cache', saknas = 'not found', extra = {} } = {}) {
  const fp = [].concat(filer).find(arFil);
  if (!fp) return json(res, 404, { error: saknas });
  let st; try { st = fs.statSync(fp); } catch { return json(res, 404, { error: saknas }); }
  res.writeHead(200, { 'content-type': mime(fp), 'cache-control': cache, 'content-length': st.size, ...extra });
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(fp);
  s.on('error', () => res.destroy());
  s.pipe(res);
}
function skickaMedRange(req, res, fp) {
  let st; try { st = fs.statSync(fp); } catch { return json(res, 404, { error: 'not found' }); }
  const size = st.size;
  const head = { 'content-type': mime(fp), 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
  const range = req.headers.range;
  let start = 0, end = size - 1, kod = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { ...head, 'content-range': `bytes */${size}` }); return res.end(); }
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) { res.writeHead(416, { ...head, 'content-range': `bytes */${size}` }); return res.end(); }
    kod = 206; head['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  head['content-length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(kod, head);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const s = fs.createReadStream(fp, { start, end });
  s.on('error', () => res.destroy());
  s.pipe(res);
}
// En relativ sökväg inom en baskatalog, eller null. Skyddar mot ../ och mot avkodningsfel.
function inom(bas, rel) {
  let r; try { r = decodeURIComponent(rel); } catch { return null; }
  if (r.includes('\0')) return null;
  const fp = path.resolve(bas, '.' + path.sep + r);
  return fp === bas || fp.startsWith(bas + path.sep) ? fp : null;
}
function omdirigera(res, till) { res.writeHead(301, { location: till }); res.end(); }

// ---------- kolonin ----------
function tileTeams() {
  let poster; try { poster = fs.readdirSync(COLONY); } catch { return []; }
  return poster.filter(f => TEAM_DIR_RE.test(f) && !DOLDA_RUTOR.has(f) && arFil(path.join(COLONY, f, 'index.html'))).sort();
}
function pluginTeams() {
  let poster; try { poster = fs.readdirSync(PLUGINS); } catch { return []; }
  return poster.filter(f => TEAM_DIR_RE.test(f) && arFil(path.join(PLUGINS, f, 'index.js'))).sort();
}
// Rutans huvud: <title>, och om rutan säger att den är gruppens gemensamma app
// (<meta name="colony" content="group-app">). Den visas då först och störst, i gruppens koloni och på hubben.
function tileHuvud(team) {
  try {
    const fd = fs.openSync(path.join(COLONY, team, 'index.html'), 'r');
    const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
    const huvud = buf.toString('utf8', 0, n);
    const m = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(huvud);
    const app = /<meta\s+(?=[^>]*\bname=["']colony["'])(?=[^>]*\bcontent=["']group-app["'])[^>]*>/i.test(huvud);
    return { titel: m ? rensaRad(m[1], 120) || null : null, app };
  } catch { return { titel: null, app: false }; }
}
function tileTitel(team) { return tileHuvud(team).titel; }
function tiles() {
  return tileTeams().map(team => {
    const h = tileHuvud(team);
    return { team, path: team + '/', url: `/colony/${encodeURIComponent(team)}/`, title: h.titel, hero: heroUrl(team), group_app: h.app };
  });
}
function hashaKatalog(dir) {
  const h = crypto.createHash('sha1'); let antal = 0;
  const ga = (d, rel, djup) => {
    if (djup > 8 || antal > 5000) return;
    let poster; try { poster = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    poster.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const p of poster) {
      if (p.name.startsWith('.') || p.name === 'node_modules') continue;
      const fp = path.join(d, p.name), r = rel ? rel + '/' + p.name : p.name;
      if (p.isDirectory()) ga(fp, r, djup + 1);
      else if (p.isFile()) {
        antal++;
        h.update(r + '\0');
        try { const st = fs.statSync(fp); h.update(st.size <= 5 * 1024 * 1024 ? fs.readFileSync(fp) : `size:${st.size}`); } catch {}
        h.update('\0');
      }
    }
  };
  ga(dir, '', 0);
  return h.digest('hex');
}
// Kolonin berättar själv: vid start jämförs rutor och plugins med förra körningen. Första starten någonsin
// (ingen colony-state.json) sparar bara läget, annars skulle varje befintlig ruta ropas ut på en gång.
const COLONY_STATE = path.join(DATA_DIR, 'colony-state.json');
function kolonistart() {
  const nu = { tiles: {}, plugins: {} };
  for (const t of tileTeams()) nu.tiles[t] = hashaKatalog(path.join(COLONY, t));
  for (const t of pluginTeams()) nu.plugins[t] = hashaKatalog(path.join(PLUGINS, t));
  let forra = null;
  try { forra = JSON.parse(fs.readFileSync(COLONY_STATE, 'utf8')); } catch {}
  skrivAtomiskt(COLONY_STATE, JSON.stringify({ ...nu, ts: Date.now() }, null, 1));
  if (!forra || typeof forra !== 'object') { console.log('colony: first start, saving the state of the tiles without announcing anything'); return []; }
  const ft = forra.tiles || {}, fp = forra.plugins || {};
  const gammal = (o, k) => (harEgen(o, k) ? o[k] : null);
  const poster = [];
  for (const t of [...new Set([...Object.keys(nu.tiles), ...Object.keys(nu.plugins)])].sort()) {
    if (DOLDA_RUTOR.has(t)) continue;
    const tile = nu.tiles[t] || null, plugin = nu.plugins[t] || null;
    const tileNy = tile && !gammal(ft, t), tileAndrad = tile && gammal(ft, t) && gammal(ft, t) !== tile;
    const pluginNy = plugin && !gammal(fp, t), pluginAndrad = plugin && gammal(fp, t) && gammal(fp, t) !== plugin;
    if (tileNy) poster.push(`@${t} your tile is live in the colony: ${PUBLIC_URL}/colony/${encodeURIComponent(t)}/`);
    else if (tile && (tileAndrad || pluginNy || pluginAndrad)) poster.push(`@${t} your update is live in the colony`);
    else if (!tile && pluginNy) poster.push(`@${t} your backend is live in the colony: ${PUBLIC_URL}/t/${encodeURIComponent(t)}/`);
    else if (!tile && pluginAndrad) poster.push(`@${t} your update is live in the colony`);
  }
  for (const p of poster) botPost('colony', 'build', p);
  return poster;
}

// ---------- plugins: teamens backends ----------
// board/plugins/<team>/index.js exporterar { handle(req, res, ctx), onMessage(m, ctx) } — båda valfria.
// ctx = { team, path, url, board: { post, query, channels, agents, subscribe, roster, activity, evolution, spores }, dataDir }.
// Ett plugin som kastar dödar inte servern.
const plugins = new Map();
const subscribers = new Set();
function boardApi(team) {
  return {
    post: (text, channel = HUVUDKANAL, reply_to) => post(JSON.stringify({ from: team, channel, text, reply_to }), null),
    query: (params) => query(new URLSearchParams(params)).map(m => { const c = { ...m }; delete c.ip; return c; }),
    channels, agents,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    roster: () => lagSnapshot().teams,
    activity: () => aktivitetSnapshot(),
    evolution: (params = {}) => evolutionQuery(new URLSearchParams(params)),
    spores: () => [...sporer.values()].map(s => ({ ...s })),
  };
}
function loadPlugins() {
  if (!fs.existsSync(PLUGINS)) return;
  for (const team of fs.readdirSync(PLUGINS)) {
    const entry = path.join(PLUGINS, team, 'index.js');
    if (!TEAM_DIR_RE.test(team) || !fs.existsSync(entry)) continue;
    if (arReserverat(team)) { console.error(`plugin ${team} skipped: the name is reserved for the board's own bots`); continue; }
    try {
      const mod = require(entry);
      const dataDir = path.join(DATA_DIR, 'plugins', team); fs.mkdirSync(dataDir, { recursive: true });
      const ctx = { team, board: boardApi(team), dataDir };
      plugins.set(team, { mod, ctx });
      if (typeof mod.onMessage === 'function') subscribers.add(m => { try { const r = mod.onMessage(m, ctx); if (r && r.catch) r.catch(e => console.error(`[${team}] onMessage:`, e.message)); } catch (e) { console.error(`[${team}] onMessage:`, e.message); } });
      if (typeof mod.init === 'function') { try { mod.init(ctx); } catch (e) { console.error(`[${team}] init:`, e.message); } }
      console.log(`plugin: ${team}`);
    } catch (e) { console.error(`plugin ${team} could not be loaded:`, e.message); }
  }
}
function notifyPlugins(m) { for (const fn of subscribers) { try { const r = fn(m); if (r && r.catch) r.catch(() => {}); } catch {} } }
// Sökvägen avkodas innan den slås upp: ett kvarter som heter något med å, ä eller ö kommer in som
// /t/sk%C3%A4rg%C3%A5rden/ och matchade annars aldrig sitt eget plugin. Gäller ctx.path också.
const avkoda = s => { try { return decodeURIComponent(s); } catch { return s; } };
async function servePlugin(req, res, url) {
  const [, , team, ...rest] = url.pathname.split('/').map(avkoda);
  const p = plugins.get(team);
  if (!p || typeof p.mod.handle !== 'function') return json(res, 404, { error: `no plugin for ${team}` });
  try {
    const handled = await p.mod.handle(req, res, { ...p.ctx, path: '/' + rest.join('/'), url });
    if (!handled && !res.headersSent) json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[${team}] handle:`, e.message);
    if (!res.headersSent) json(res, 500, { error: `plugin ${team}: ${e.message}` });
  }
}
function pluginList() { return [...plugins.keys()].map(team => ({ team, routes: typeof plugins.get(team).mod.handle === 'function', listens: typeof plugins.get(team).mod.onMessage === 'function' })); }

// ---------- server ----------
const sida = namn => path.join(PUBLIC, namn);
const ROTFIL_RE = /^\/[\w.-]+\.(css|js|mjs|svg|png|jpe?g|webp|gif|ico|json|txt|woff2?)$/;
const SPORE_ROUTE_RE = /^\/api\/sporer\/([^/]+)(?:\/(integrerad|integrated))?\/?$/;

async function hantera(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);
  const GET = req.method === 'GET' || req.method === 'HEAD';
  const POST = req.method === 'POST';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type, x-lead-token' });
    return res.end();
  }
  if (p.startsWith('/t/')) return servePlugin(req, res, url);

  // --- sidor ---
  if (GET) {
    if (p === '/' || p === '/index.html') return IS_HUB ? skickaFil(req, res, [sida('hub.html'), sida('index.html')]) : skickaFil(req, res, sida('index.html'));
    if (p === '/square' || p === '/square/' || p === '/torget' || p === '/torget/') return skickaFil(req, res, sida('index.html'));
    if (p === '/hub' && IS_HUB) return skickaFil(req, res, sida('hub.html'), { saknas: 'hub.html is not here yet' });
    // workshop.html är den engelska huvudsidan och /workshop/en ett alias till den. workshop.en.html serveras
    // bara om den ligger kvar från förr (då var workshop.html svensk). /workshop/sv: den svenska om den finns.
    if (p === '/workshop' || p === '/workshop/' || p === '/workshop.html') return skickaFil(req, res, sida('workshop.html'), { saknas: 'workshop.html is not here yet' });
    if (p === '/workshop/en' || p === '/workshop/en/' || p === '/workshop.en.html') return skickaFil(req, res, [sida('workshop.en.html'), sida('workshop.html')], { saknas: 'workshop.html is not here yet' });
    if (p === '/workshop/sv' || p === '/workshop/sv/' || p === '/workshop.sv.html') return skickaFil(req, res, [sida('workshop.sv.html'), sida('workshop.html')], { saknas: 'workshop.html is not here yet' });
    if (p === '/teams' || p === '/teams/' || p === '/lagen') return skickaFil(req, res, sida('teams.html'), { saknas: 'teams.html is not here yet' });
    if (p === '/news' || p === '/news/') return skickaFil(req, res, sida('news.html'), { saknas: 'news.html is not here yet' });
    if (p === '/radio' || p === '/radio/') return skickaFil(req, res, sida('radio.html'), { saknas: 'radio.html is not here yet' });
    if (p === '/nav.js') return skickaFil(req, res, sida('nav.js'), { saknas: 'nav.js is not here yet' });
    if (p === '/qr.png' || p === '/qr.svg') return skickaFil(req, res, sida(p.slice(1)), { saknas: 'no qr code yet: the workshop lead puts it in board/public/qr.png' });
    if (p === '/colony' || p === '/staden' || p === '/staden/') return omdirigera(res, '/colony/' + url.search);
    if (p.startsWith('/staden/kvarter/')) return omdirigera(res, '/colony/' + p.slice('/staden/kvarter/'.length) + url.search);
    if (p.startsWith('/staden/')) return omdirigera(res, '/colony/' + p.slice('/staden/'.length) + url.search);
    if (p === '/colony/' || p === '/colony/index.html') return skickaFil(req, res, [path.join(COLONY, 'index.html'), sida('staden/index.html')], { saknas: 'the colony page is not here yet' });
    if (p.startsWith('/colony/')) {
      const fp = inom(COLONY, p.slice('/colony/'.length));
      if (!fp) return json(res, 404, { error: 'not found' });
      if (arKatalog(fp)) {
        if (!p.endsWith('/')) return omdirigera(res, p + '/' + url.search);
        return skickaFil(req, res, path.join(fp, 'index.html'));
      }
      return skickaFil(req, res, fp);
    }
    if (p.startsWith('/hero/')) {
      const team = avkoda(p.slice('/hero/'.length)).replace(/\/+$/, '');
      if (!NAME_RE.test(team)) return json(res, 404, { error: 'not found' });
      const fp = heroFil(team);
      if (!fp) return json(res, 404, { error: `no hero image for ${team} yet` });
      return skickaFil(req, res, fp, { cache: 'public, max-age=60', extra: { 'access-control-allow-origin': '*' } });
    }
    if (p.startsWith('/radio/fil/')) {
      const fp = inom(path.resolve(RADIO), p.slice('/radio/fil/'.length));
      if (!fp || !arFil(fp)) return json(res, 404, { error: 'not found' });
      return skickaMedRange(req, res, fp);
    }
    if (ROTFIL_RE.test(p)) return skickaFil(req, res, sida(p.slice(1)));
  }

  // --- API ---
  if (p === '/api/health') return json(res, 200, halsa());
  if (p === '/api/plugins') return json(res, 200, pluginList());
  if (p === '/api/tiles' || p === '/api/tiles/') return json(res, 200, tiles());
  if (p === '/api/kvarter') return json(res, 200, tileTeams().map(t => t + '/'));

  if (p === '/api/messages' && GET) {
    const out = query(url.searchParams).map(m => { const c = { ...m }; delete c.ip; return c; });
    return wantsText(req) ? text(res, 200, out.map(fmt).join('\n') + (out.length ? '\n' : '')) : json(res, 200, out);
  }
  if (p === '/api/messages' && POST) {
    if (limited(ip)) return json(res, 429, { error: `max ${LIMITS.perMinute} posts per minute` });
    let body; try { body = (await readBody(req)).toString('utf8'); } catch { return json(res, 413, { error: 'body too large (max 64 KB)' }); }
    const r = post(body, ip, req.headers['content-type'] || '', { utifran: true, ledare: ledarToken(req) });
    if (r.error) return json(res, r.status || 400, { error: r.error });
    return wantsText(req) ? text(res, 201, fmt(r.message) + '\n') : json(res, 201, r.message);
  }
  if (p === '/api/channels') {
    const c = channels();
    return wantsText(req) ? text(res, 200, c.map(x => `#${x.channel} (${x.count}, last id ${x.last_id})`).join('\n') + '\n') : json(res, 200, c);
  }
  if (p === '/api/agents') {
    const a = agents();
    return wantsText(req) ? text(res, 200, a.map(x => `${x.name} — ${x.count} posts, ${x.channels.map(c => '#' + c).join(' ')}`).join('\n') + '\n') : json(res, 200, a);
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.write(': hello\n\n');
    const client = { res, channel: url.searchParams.get('channel') ? kanalNamn(url.searchParams.get('channel')) : null };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); });
    return;
  }

  // roster och evolution
  if (p === '/api/lag' && POST) {
    const d = await lasJson(req, res, 256 * 1024); if (!d) return;
    const r = taEmotLag(d);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, r.status, r.body);
  }
  if (p === '/api/lag' && GET) return json(res, 200, lagSnapshot());
  if (p === '/api/evolution' && GET) {
    const out = evolutionQuery(url.searchParams);
    return wantsText(req) ? text(res, 200, out.map(e => `[${e.id}] ${klocka(e.ts)} ${e.text}`).join('\n') + (out.length ? '\n' : '')) : json(res, 200, out);
  }
  // aktivitet
  if (p === '/api/aktivitet' && POST) {
    const d = await lasJson(req, res, 8 * 1024); if (!d) return;
    const r = taEmotAktivitet(d);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, r.status, r.body);
  }
  if (p === '/api/aktivitet' && GET) return json(res, 200, aktivitetSnapshot());

  // sporer
  if ((p === '/api/sporer' || p === '/api/sporer/') && POST) {
    const d = await lasJson(req, res, 32 * 1024); if (!d) return;
    const r = nySpore(d);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, r.status, r.body);
  }
  if ((p === '/api/sporer' || p === '/api/sporer/') && GET) {
    const r = await sporLista(url.searchParams);
    if (wantsText(req)) return text(res, 200, (r.hub === false ? '(the hub is not reachable right now: only this group\'s spores)\n' : '') + r.sporer.map(sporeText).join('\n\n') + (r.sporer.length ? '\n' : ''));
    return json(res, 200, r);
  }
  const sm = SPORE_ROUTE_RE.exec(p);
  if (sm) {
    const id = avkoda(sm[1]);
    if (sm[2] && POST) {
      const d = await lasJson(req, res, 16 * 1024); if (!d) return;
      const r = await integrera(id, d);
      return r.error ? json(res, r.status, { error: r.error }) : json(res, r.status, r.body);
    }
    if (!sm[2] && GET) {
      const r = await sporLista(new URLSearchParams({ limit: '1000' }));
      const s = r.sporer.find(x => x.id === id);
      return s ? json(res, 200, s) : json(res, 404, { error: `unknown spore id ${kort(id, 70)}` });
    }
  }
  // hubben
  if (p === '/api/hub/sporer' && POST) {
    if (!IS_HUB) return json(res, 404, { error: 'this board is not the hub' });
    if (!arLoopback(req)) return json(res, 403, { error: 'spores are forwarded server to server only, from the same machine' });
    const d = await lasJson(req, res, 4 * 1024 * 1024); if (!d) return;
    return json(res, 200, hubTarEmot(d));
  }
  if (p === '/api/hub/grupper' && GET) {
    if (!IS_HUB) return json(res, 404, { error: 'this board is not the hub' });
    return json(res, 200, gruppLista());
  }

  // nyheter
  if ((p === '/api/news' || p === '/api/news/') && POST) {
    if (!kravLedare(req, res)) return;
    const d = await lasJson(req, res, 256 * 1024); if (!d) return;
    const r = taEmotNyhet(d);
    return r.error ? json(res, r.status, { error: r.error }) : json(res, r.status, r.body);
  }
  if ((p === '/api/news' || p === '/api/news/') && GET) {
    const lista = [...nyheter.values()].sort((a, b) => b.nummer - a.nummer);
    return json(res, 200, lista.slice(0, tal(url.searchParams.get('limit'), 20, 500)));
  }
  const nm = /^\/api\/news\/(\d+)$/.exec(p);
  if (nm && GET) { const n = nyheter.get(Number(nm[1])); return n ? json(res, 200, n) : json(res, 404, { error: `no issue #${nm[1]}` }); }

  // gruppens anteckningar (t.ex. API-nycklar som bara den här gruppen behöver). Ligger i DATA_DIR och aldrig i det
  // publika repot. Bara ledaren skriver, och bara när LEAD_TOKEN är satt: utan token skulle vem som helst kunna det.
  if ((p === '/api/notes' || p === '/api/notes/') && GET) {
    let notes = null, ts = null;
    try { notes = fs.readFileSync(NOTES_FIL, 'utf8'); ts = Math.round(fs.statSync(NOTES_FIL).mtimeMs); } catch {}
    return json(res, 200, { notes, ts });
  }
  if ((p === '/api/notes' || p === '/api/notes/') && POST) {
    if (!LEAD_TOKEN || !ledarToken(req)) return json(res, 403, { error: 'Only the workshop lead can set the group notes (x-lead-token).' });
    let buf; try { buf = await readBody(req, 20 * 1024); } catch { return json(res, 413, { error: 'notes too long: max 20 KB' }); }
    const text = buf.toString('utf8');
    if (!text.trim()) { try { fs.unlinkSync(NOTES_FIL); } catch {} return json(res, 200, { ok: true, notes: null }); }
    if (!skrivAtomiskt(NOTES_FIL, text)) return json(res, 500, { error: 'could not save the notes' });
    return json(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
  }

  // radio
  if (p === '/api/radio' && GET) { const r = await radioLista(); return json(res, r.status, r.body); }

  // hero
  if (p.startsWith('/api/hero/') && POST) {
    const team = avkoda(p.slice('/api/hero/'.length)).replace(/\/+$/, '');
    if (!NAME_RE.test(team)) return json(res, 400, { error: `team: ${NAME_HELP}` });
    if (!kravLedare(req, res)) return;
    const MAX = 1.5 * 1024 * 1024;
    let buf; try { buf = await readBody(req, MAX); } catch { return json(res, 413, { error: 'image too large: max 1.5 MB' }); }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = ct === 'image/png' ? 'png' : (ct === 'image/jpeg' || ct === 'image/jpg') ? 'jpg' : null;
    if (!ext) return json(res, 415, { error: 'content-type must be image/jpeg or image/png' });
    const arPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const arJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if ((ext === 'png' && !arPng) || (ext === 'jpg' && !arJpg)) return json(res, 415, { error: `the body is not a valid ${ext === 'png' ? 'PNG' : 'JPEG'} image` });
    if (!skrivAtomiskt(path.join(HEROES, `${team}.${ext}`), buf)) return json(res, 500, { error: 'could not save the image' });
    try { fs.unlinkSync(path.join(HEROES, `${team}.${ext === 'png' ? 'jpg' : 'png'}`)); } catch {}
    return json(res, 201, { ok: true, team, hero: heroUrl(team), bytes: buf.length });
  }

  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  hantera(req, res).catch(e => {
    console.error('request failed:', (e && e.stack) || e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.destroy();
  });
});

// Härdning: serverns try/catch skyddar bara det SYNKRONA anropet in i ett plugin. Det ett kvarter
// lägger i setTimeout, setInterval eller ett löfte utan .catch() kastar utanför det skyddet, och
// ett ofångat undantag tar ner hela processen — alla kvarter med den. Förra gången hände det:
// en enda odefinierad funktion i en 800 ms-timer släckte tretton kvarter samtidigt.
// De här två raderna gör felet till en lograd i stället. Teamen ska ändå ha try/catch INUTI sin
// callback, och unref() på timern; se board/plugins/README.md.
process.on('uncaughtException', e => console.error('uncaught exception:', (e && e.stack) || e));
process.on('unhandledRejection', e => console.error('unhandled rejection:', (e && e.stack) || e));

loadPlugins();
if (require.main === module) {
  try { kolonistart(); } catch (e) { console.error('colony check failed:', e.message); }
  // Allt som pratar med andra servrar är asynkront med tidsgräns, och timrarna håller inte processen vid liv.
  if (HUB_URL) {
    for (const s of sporer.values()) if ((s.grupp || null) === (GRUPP || null)) utkorg.push({ spore: s });
    for (const lista of fremmandeInteg.values()) for (const i of lista) utkorg.push({ integ: i });
    setInterval(tommUtkorg, HUB_RETRY_MS).unref();
  }
  if (IS_HUB) setInterval(pollaGrupper, HUB_POLL_MS).unref();
  server.listen(PORT, () => {
    const port = server.address().port;
    console.log(`The Square listening on http://localhost:${port}  (${LAGE}${GRUPP ? ' ' + GRUPP : ''}, ${messages.length} posts in ${FILE})`);
    if (HUB_URL) tommUtkorg();
    if (IS_HUB) pollaGrupper();
  });
}
module.exports = { server, post, query, channels, agents, plugins };
