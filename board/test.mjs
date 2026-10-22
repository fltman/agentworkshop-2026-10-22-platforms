// Kör: node test.mjs   (startar servrar på lediga portar i tomma kataloger)
//
// Testerna kör mot en EGEN pluginkatalog (PLUGINS_DIR) och en egen kolonikatalog (COLONY_DIR). Annars mäts
// absoluta antal med alla teams plugins och rutor inlästa, och ett enda kvarter som postar när det startar
// gör sviten röd — för alla, mitt i mergekön. Det hände förra gången.
//
// Delar: 1 klassiskt läge (som förut, och kanalen torget som alias för square), 2 det nya i klassiskt läge (roster, evolution, aktivitet, sporer,
// nyheter, radio, hero, reserverade namn), 3 kolonin berättar själv, 4 en grupp och en hubb som pratar med varandra.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const HAR = dirname(fileURLToPath(import.meta.url));
const PUB = join(HAR, 'public');
const tmp = namn => mkdtempSync(join(tmpdir(), `square-${namn}-`));
const vanta = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = (name) => console.log(`  ✓ ${name}`, ++n);
const del = rubrik => console.log(`\n${rubrik}`);

// ---------- hjälp ----------
// stderr fångas i stället för att skrivas rakt ut: ett av testerna får med flit ett plugin att kasta,
// och en grön svit ska inte se ut som ett fel. Loggen skrivs ut om något fallerar.
let logg = '';
const igang = new Set();
function ledigPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function starta(env, namn = 'server') {
  const proc = spawn(process.execPath, [join(HAR, 'server.js')], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  igang.add(proc);
  proc.stderr.on('data', d => { logg += `[${namn}] ${d}`; });
  let ut = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${namn} did not start`)), 8000);
    proc.stdout.on('data', d => { ut += d; logg += `[${namn}] ${d}`; const m = /listening on http:\/\/localhost:(\d+)/.exec(ut); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error(`${namn} exited with ${c}`)); });
  });
  const stoppa = () => new Promise(r => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.on('exit', () => r()); proc.kill(); });
  return { proc, port, B: `http://localhost:${port}`, stoppa };
}
async function hamta(B, p, opt = {}) {
  const r = await fetch(B + p, opt);
  const buf = Buffer.from(await r.arrayBuffer());
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, json: j, text: buf.toString('utf8'), buf, headers: r.headers };
}
const postJson = (B, p, body, headers = {}) => hamta(B, p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const kanal = async (B, ch) => (await hamta(B, `/api/messages?channel=${ch}&limit=500`)).json;
async function tills(fn, ms = 5000, vad = 'condition') {
  const slut = Date.now() + ms;
  while (Date.now() < slut) { const v = await fn(); if (v) return v; await vanta(50); }
  throw new Error(`timed out waiting for ${vad}`);
}
// En sida som en annan agent skriver: finns filen ska den serveras, annars ett 404 med en förklaring.
async function sidan(B, route, fil) {
  const r = await hamta(B, route);
  if (existsSync(join(PUB, fil))) { assert.equal(r.status, 200, route); assert.equal(r.text, readFileSync(join(PUB, fil), 'utf8')); }
  else { assert.equal(r.status, 404, route); assert.match(r.json.error, new RegExp(fil.replace('.', '\\.'))); }
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);

// ---------- kataloger ----------
const dir = tmp('data');
const pdir = tmp('plugins');
const cdir = tmp('colony');
// Exempelpluginet följer med om det finns (det heter exempelkvarteret i mallen).
const EXEMPEL = ['exempelkvarteret', 'example-team', 'example'].find(d => existsSync(join(HAR, 'plugins', d, 'index.js')));
if (EXEMPEL) cpSync(join(HAR, 'plugins', EXEMPEL), join(pdir, EXEMPEL), { recursive: true });
// Provkvarter med å, ä och ö i namnet, och en route som kastar inifrån en timer.
mkdirSync(join(pdir, 'skärgårdskajen'), { recursive: true });
writeFileSync(join(pdir, 'skärgårdskajen', 'index.js'), `module.exports = {
  async handle(req, res, ctx) {
    if (ctx.path === '/räd') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, väg: ctx.path })); return true; }
    if (ctx.path === '/krascha') { setTimeout(() => { finnsInteAlls(); }, 20); res.writeHead(204); res.end(); return true; }
    return false;
  },
};
`);
// Ett plugin med ett reserverat namn ska inte laddas (det skulle kunna posta som botten).
mkdirSync(join(pdir, 'evolution'), { recursive: true });
writeFileSync(join(pdir, 'evolution', 'index.js'), 'module.exports = { init(ctx) { ctx.board.post("fake", "evolution"); } };\n');
writeFileSync(join(cdir, 'index.html'), '<!doctype html><title>The colony</title>\n');
mkdirSync(join(cdir, 'exempelkvarteret'), { recursive: true });
writeFileSync(join(cdir, 'exempelkvarteret', 'index.html'), '<!doctype html><title>Example tile</title><p>hello</p>\n');
// En dold ruta (som mallens exempel i drift): serveras, men listas inte och ropas inte ut.
mkdirSync(join(cdir, 'provrutan-dold'), { recursive: true });
// Gruppens gemensamma app: markeras med en meta-rad i rutans <head>.
mkdirSync(join(cdir, 'provappen'), { recursive: true });
writeFileSync(join(cdir, 'provappen', 'index.html'), '<!doctype html><title>Group app</title><meta content="group-app" name="colony"><p>app</p>\n');
writeFileSync(join(cdir, 'provrutan-dold', 'index.html'), '<!doctype html><title>Hidden tile</title><p>hidden</p>\n');

const MILJO = { DATA_DIR: dir, PLUGINS_DIR: pdir, COLONY_DIR: cdir, EVO_CHAT_MS: '1500', COLONY_HIDE: 'provrutan-dold' };
let S = await starta(MILJO, 'klassisk');
let B = S.B;
const post = (body, headers = {}) => fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  del('1. Klassiskt läge, som förut');
  // 1. tomt vid start
  assert.deepEqual(await (await fetch(B + '/api/messages')).json(), []); ok('tom tavla');
  // 2. posta
  let r = await post({ from: 'anna-agent', channel: 'square', text: 'Hej @bo-agent, vad bygger du?' });
  assert.equal(r.status, 201); const m1 = await r.json(); assert.equal(m1.id, 1); assert.equal(m1.ip, undefined); ok('posta (ip läcker inte)');
  // 3. validering, med förklaringar på engelska
  r = await post({ from: '', text: 'x' }); assert.equal(r.status, 400); assert.match((await r.json()).error, /^from: letters/); ok('avvisar tomt namn');
  r = await post({ from: 'x', channel: 'Fel Kanal!', text: 'x' }); assert.equal(r.status, 400); ok('avvisar ogiltig kanal');
  r = await post({ from: 'x', text: 'a'.repeat(2001) }); assert.equal(r.status, 400); assert.match((await r.json()).error, /max 2000 characters/); ok('avvisar för lång text');
  r = await post({ from: 'x', text: 'x', reply_to: 999 }); assert.equal(r.status, 400); ok('avvisar okänt reply_to');
  r = await fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{trasig' }); assert.equal(r.status, 400); ok('trasig JSON ger 400, ingen krasch');
  r = await fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }); assert.equal(r.status, 400); ok('JSON null ger 400, ingen krasch');
  // 4. svar + mention + kanal
  r = await post({ from: 'bo-agent', channel: 'build', text: 'En väderbot!', reply_to: 1 }); assert.equal(r.status, 201); ok('svar på inlägg');
  r = await post({ from: 'bo-agent', text: 'ärver kanal', reply_to: 2 }); assert.equal((await r.json()).channel, 'build'); ok('svar ärver kanalen');
  r = await fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'from=form-agent&channel=build&text=' + encodeURIComponent('via formulär & åäö') });
  assert.equal(r.status, 201); assert.equal((await r.json()).text, 'via formulär & åäö'); ok('form-urlencoded');
  r = await post({ from: 'cia', channel: 'torget', text: 'åäö fungerar' }); assert.equal((await r.json()).channel, 'square'); ok('kanalen torget (det gamla namnet) blir square');
  let list = await (await fetch(B + '/api/messages?mention=bo-agent')).json(); assert.equal(list.length, 1); assert.equal(list[0].id, 1); ok('mention-filter');
  await post({ from: 'dina', channel: 'square', text: '@alla brainstorm om kartor → #brainstorm-kartor' });
  list = await (await fetch(B + '/api/messages?mention=bo-agent')).json(); assert.deepEqual(list.map(x => x.id), [1, 6]); ok('@alla når alla');
  list = await (await fetch(B + '/api/messages?mention=dina')).json(); assert.equal(list.length, 0); ok('egna @alla räknas inte');
  list = await (await fetch(B + '/api/messages?channel=build')).json(); assert.equal(list.length, 3); ok('kanalfilter');
  list = await (await fetch(B + '/api/messages?since=1')).json(); assert.deepEqual(list.map(x => x.id), [2, 3, 4, 5, 6]); ok('since');
  list = await (await fetch(B + '/api/messages?q=åäö')).json(); assert.equal(list.length, 2); ok('sökning med åäö');
  // 5. textformat
  const t = await (await fetch(B + '/api/messages', { headers: { accept: 'text/plain' } })).text();
  assert.match(t, /^#square \[1\] \d\d:\d\d anna-agent: Hej @bo-agent/m); ok('textformat');
  // 6. kanaler + agenter
  const ch = await (await fetch(B + '/api/channels')).json(); assert.deepEqual(ch.map(c => c.channel).sort(), ['build', 'square']); ok('kanaler (inget #torget)');
  const ag = await (await fetch(B + '/api/agents')).json(); assert.equal(ag.length, 5); ok('agenter');
  // 7. SSE
  const ctrl = new AbortController();
  const sse = await fetch(B + '/api/stream?channel=torget', { signal: ctrl.signal });   // det gamla namnet
  const reader = sse.body.getReader(); const dec = new TextDecoder();
  await post({ from: 'bo-agent', channel: 'build', text: 'inte i square' });
  await post({ from: 'bo-agent', channel: 'square', text: 'live!' });
  let buf = ''; while (!/live!/.test(buf)) buf += dec.decode((await reader.read()).value);
  assert.ok(!/inte i square/.test(buf)); ctrl.abort(); ok('SSE med kanalfilter, även med det gamla namnet torget');
  // 7a. plugins
  const pl = await (await fetch(B + '/api/plugins')).json();
  assert.ok(!pl.some(x => x.team === 'evolution')); ok('plugin med reserverat namn laddas inte');
  if (EXEMPEL) {
    assert.ok(pl.some(x => x.team === EXEMPEL && x.routes && x.listens)); ok('exempelplugin laddat');
    assert.equal((await fetch(`${B}/t/${EXEMPEL}/status`)).status, 200); ok(`plugin-route /t/${EXEMPEL}/status`);
  }
  assert.equal((await fetch(B + '/t/finns-inte/x')).status, 404); ok('okänt plugin → 404');
  if (EXEMPEL) {
    await post({ from: 'nyfiken', channel: 'square', text: `@${EXEMPEL} hur många är vi?` });
    list = await tills(async () => { const l = await (await fetch(B + '/api/messages?channel=square&limit=1')).json(); return l[0].from === EXEMPEL && l; }, 3000, 'svar från exempelpluginet');
    assert.match(list[0].text, /agent/); ok('plugin svarar via onMessage');
  } else {
    await post({ from: 'nyfiken', channel: 'square', text: 'inget exempelplugin i den här mallen' });
    await post({ from: 'nyfiken', channel: 'square', text: 'så två inlägg i stället' });
  }
  assert.deepEqual(await kanal(B, 'torget'), await kanal(B, 'square')); ok('channel=torget läser #square');
  // 7b. kvarter med å, ä eller ö i namnet: sökvägen kommer in procentkodad och måste avkodas
  const ra = await fetch(B + '/t/' + encodeURIComponent('skärgårdskajen') + '/' + encodeURIComponent('räd'));
  assert.equal(ra.status, 200); assert.deepEqual(await ra.json(), { ok: true, 'väg': '/räd' }); ok('plugin-route med å ä ö');
  // 7c. en throw inne i en timer ligger utanför serverns try/catch och tog förr ner hela tavlan
  assert.equal((await fetch(B + '/t/' + encodeURIComponent('skärgårdskajen') + '/krascha')).status, 204);
  await vanta(400);
  const h = await (await fetch(B + '/api/health')).json();
  assert.equal(h.ok, true); assert.ok(h.startad > 0); ok('plugin-timer som kastar tar inte ner tavlan');
  assert.equal((await fetch(B + '/qr.png')).status, 404); ok('qr-kod saknas tills ledaren lagt dit en');
  // 8. persistens: starta om, allt kvar
  await S.stoppa();
  S = await starta({ ...MILJO, PORT: String(S.port) }, 'klassisk-2');
  list = await (await fetch(B + '/api/messages')).json(); assert.equal(list.length, 10); ok('persistens över omstart');
  r = await post({ from: 'x', text: 'ny' }); const m11 = await r.json(); assert.equal(m11.id, 11); assert.equal(m11.channel, 'square'); ok('id fortsätter efter omstart; utan kanal hamnar inlägget i #square');
  assert.equal((await kanal(B, 'build')).filter(m => m.from === 'colony').length, 0); ok('ingen kolonipost när inget ändrats');
  // Data från före namnbytet: inlägg i #torget på disk, och ett plugin som postar i "torget" och utan kanal.
  {
    const gd0 = tmp('gammal'), gp0 = tmp('gammal-plugins');
    const t0 = Date.now() - 60_000;
    writeFileSync(join(gd0, 'messages.jsonl'), [
      { id: 1, ts: t0, from: 'anna-agent', channel: 'torget', text: 'from before the rename' },
      { id: 2, ts: t0 + 1, from: 'bo-agent', channel: 'torget', text: 'a reply', reply_to: 1 },
      { id: 3, ts: t0 + 2, from: 'bo-agent', channel: 'build', text: 'build stays build' },
    ].map(m => JSON.stringify(m)).join('\n') + '\n');
    mkdirSync(join(gp0, 'gammalt'), { recursive: true });
    writeFileSync(join(gp0, 'gammalt', 'index.js'), 'module.exports = { init(ctx) { ctx.board.post("default channel"); ctx.board.post("old name", "torget"); } };\n');
    const G0 = await starta({ DATA_DIR: gd0, PLUGINS_DIR: gp0, COLONY_DIR: tmp('gammal-koloni') }, 'gammal');
    assert.deepEqual((await kanal(G0.B, 'square')).map(m => m.id), [1, 2, 4, 5]); assert.deepEqual((await kanal(G0.B, 'torget')).map(m => m.id), [1, 2, 4, 5]);
    assert.deepEqual((await hamta(G0.B, '/api/channels')).json.map(c => c.channel).sort(), ['build', 'square']); ok('gamla inlägg i #torget läses som #square');
    assert.deepEqual((await kanal(G0.B, 'square')).filter(m => m.from === 'gammalt').map(m => m.text), ['default channel', 'old name']); ok('board.post i ett plugin: standardkanalen är square, och "torget" blir square');
    const y0 = await postJson(G0.B, '/api/messages', { from: 'cia', text: 'svar', reply_to: 1 }); assert.equal(y0.json.channel, 'square'); ok('svar på ett gammalt #torget-inlägg hamnar i #square');
    await G0.stoppa();
    assert.match(readFileSync(join(gd0, 'messages.jsonl'), 'utf8').split('\n')[0], /"channel":"torget"/); ok('filen på disk skrivs inte om');
  }

  del('2. Det nya, i klassiskt läge');
  let hh = (await hamta(B, '/api/health')).json;
  assert.equal(hh.mode, 'classic'); assert.equal(hh.grupp, null); assert.equal(hh.grupp_namn, null); assert.equal(hh.hub, false); assert.equal(hh.hub_url, null);
  ok('health i klassiskt läge: grupp null, hub false, hub_url null');

  // reserverade botnamn
  for (const namn of ['evolution', 'spore', 'colony', 'Evolution', 'hub', 'news', 'radio']) {
    const x = await postJson(B, '/api/messages', { from: namn, text: 'jag är botten' });
    assert.equal(x.status, 403, namn); assert.match(x.json.error, /reserved/);
  }
  ok('evolution, spore, colony, hub, news, radio kan inte postas utifrån');
  for (const namn of ['release', 'lead']) assert.equal((await postJson(B, '/api/messages', { from: namn, channel: 'build', text: 'utan LEAD_TOKEN går det som förut' })).status, 201);
  ok('release och lead fungerar som förut när LEAD_TOKEN saknas');

  // roster och evolution
  let x = await postJson(B, '/api/lag', { team: 'tomhol', lab: 'factory', harness: 'copilot', roster: { agents: ['ceo', 'hr'], kandidater: [] }, logg: ['boot'] });
  assert.equal(x.status, 200); assert.equal(x.json.events.length, 1); assert.equal(x.json.events[0].typ, 'team.ny');
  assert.equal(x.json.events[0].text, 'tomhol came online with 2 agents (agent-factory)'); ok('första rostern = EN händelse team.ny');
  let evo = await tills(async () => { const l = await kanal(B, 'evolution'); return l.length === 1 && l; }, 3000, 'första evolutionsposten');
  assert.equal(evo[0].from, 'evolution'); assert.equal(evo[0].text, 'tomhol came online with 2 agents (agent-factory)'); ok('chattpost i #evolution från "evolution" direkt');
  x = await postJson(B, '/api/lag', { team: 'tomhol', lab: 'factory', roster: { agents: ['ceo', 'hr', 'signal-tuner'], kandidater: ['api-scout'] }, logg: ['boot', 'hired signal-tuner'] });
  assert.deepEqual(x.json.events.map(e => e.typ), ['agent.ny', 'kandidat.ny', 'logg']);
  assert.equal(x.json.events[0].text, 'tomhol hired signal-tuner (agent-factory)');
  assert.equal(x.json.events[1].text, 'tomhol shortlisted candidate api-scout (agent-factory)'); ok('agent.ny, kandidat.ny och nya loggrader');
  x = await postJson(B, '/api/lag', { team: 'tomhol', lab: 'factory', roster: { agents: ['ceo', 'signal-tuner'], kandidater: ['api-scout'] }, logg: ['boot', 'hired signal-tuner'] });
  assert.deepEqual(x.json.events.map(e => e.text), ['tomhol let hr go (agent-factory)']); ok('agent.borta, och samma logg ger inga nya rader');
  assert.equal((await kanal(B, 'evolution')).length, 1); ok('ingen ny chattpost inom fönstret');
  evo = await tills(async () => { const l = await kanal(B, 'evolution'); return l.length === 2 && l; }, 4000, 'den sammanslagna posten');
  assert.equal(evo[1].text, 'tomhol: hired signal-tuner, shortlisted candidate api-scout, let hr go (agent-factory); 1 new log line');
  await vanta(400); assert.equal((await kanal(B, 'evolution')).length, 2); ok('ändringarna slogs ihop till EN post efter fönstret');

  await postJson(B, '/api/lag', { team: 'surret', lab: 'hive', roster: { formagor: [{ namn: 'kedjetest', energi: 3 }] } });
  x = await postJson(B, '/api/lag', { team: 'surret', lab: 'hive', roster: { formagor: [{ namn: 'parser', energi: 1 }], upplosta: ['kedjetest'] } });
  assert.deepEqual(x.json.events.map(e => e.text), ['surret spawned capability parser (hive)', 'surret dissolved capability kedjetest (hive)']); ok('hive: formaga.ny och formaga.upplost');
  x = await postJson(B, '/api/lag', { team: 'surret', lab: 'hive', roster: { capabilities: [{ name: 'merged', energy: 2 }], dissolved: ['kedjetest'] } });
  assert.deepEqual(x.json.events.map(e => e.typ), ['formaga.ny', 'formaga.borta']); assert.equal(x.json.events[1].text, 'surret retired capability parser (hive)'); ok('hive: formaga.borta, engelska nycklar tas också emot');
  await postJson(B, '/api/lag', { team: 'fralle', lab: 'flux', roster: { tidslinjer: ['alpha'] } });
  x = await postJson(B, '/api/lag', { team: 'fralle', lab: 'flux', roster: { tidslinjer: ['alpha', 'beta'], vinnare: ['beta'], kyrkogard: ['alpha'] } });
  assert.deepEqual(x.json.events.map(e => e.text), ['fralle branched timeline beta (flux)', "fralle's timeline beta won (flux)", 'fralle sent alpha to the graveyard (flux)']); ok('flux: tidslinje, vinnare, kyrkogård');
  x = await postJson(B, '/api/lag', { team: 'blandat', lab: 'mixed', roster: { agents: ['a'], formagor: ['b'], tidslinjer: ['c'] } });
  assert.equal(x.json.events[0].text, 'blandat came online with 1 agent, 1 capability and 1 timeline (mixed)'); ok('mixed: uppställningen i en mening');

  let ev = (await hamta(B, '/api/evolution?limit=500')).json;
  assert.ok(ev.length >= 13); assert.ok(ev.every((e, i) => i === 0 || e.id > ev[i - 1].id)); assert.ok(ev.every(e => e.grupp === null && e.ts && e.text)); ok('GET /api/evolution');
  const fr = (await hamta(B, '/api/evolution?team=fralle')).json; assert.equal(fr.length, 4); ok('GET /api/evolution?team=');
  assert.equal((await hamta(B, `/api/evolution?since=${ev[ev.length - 2].id}`)).json.length, 1); ok('GET /api/evolution?since=');
  assert.match((await hamta(B, '/api/evolution', { headers: { accept: 'text/plain' } })).text, /^\[\d+\] \d\d:\d\d tomhol came online/m); ok('evolution i textformat');
  let lagen = (await hamta(B, '/api/lag')).json;
  assert.equal(lagen.teams.tomhol.lab, 'factory'); assert.equal(lagen.teams.tomhol.harness, 'copilot');
  assert.deepEqual(lagen.teams.tomhol.roster.agents, ['ceo', 'signal-tuner']); assert.deepEqual(lagen.teams.surret.roster.formagor, [{ namn: 'merged', energi: 2 }]);
  assert.equal(lagen.teams.tomhol.hero, null); ok('GET /api/lag');
  assert.ok(JSON.parse(readFileSync(join(dir, 'lag.json'), 'utf8')).teams.fralle); ok('lag.json sparad');
  assert.equal(readFileSync(join(dir, 'evolution.jsonl'), 'utf8').trim().split('\n').length, ev.length); ok('evolution.jsonl sparad');
  assert.equal((await postJson(B, '/api/lag', { team: 'x', lab: 'kaos' })).status, 400); ok('okänt labb → 400');
  assert.equal((await postJson(B, '/api/lag', '{"team":')).status, 400); ok('trasig JSON → 400');
  assert.equal((await postJson(B, '/api/lag', { team: 'evolution', lab: 'none' })).status, 400); ok('reserverat teamnamn → 400');
  assert.equal((await postJson(B, '/api/lag', { team: 'x', lab: 'none', roster: ['fel'] })).status, 400); ok('roster som lista → 400');
  x = await postJson(B, '/api/lag', { team: 'stort', lab: 'agent-factory', roster: { agents: Array.from({ length: 150 }, (_, i) => `agent-${i}-${'x'.repeat(70)}`) } });
  assert.equal(x.status, 200); assert.ok(x.json.warnings.some(w => /first 100/.test(w)));
  lagen = (await hamta(B, '/api/lag')).json; assert.equal(lagen.teams.stort.roster.agents.length, 100); assert.equal(lagen.teams.stort.roster.agents[0].length, 60); assert.equal(lagen.teams.stort.lab, 'factory');
  ok('för långa listor och namn kapas, med en varning');

  // aktivitet
  const fore = (await hamta(B, '/api/messages?limit=500')).json.length;
  const svar = await Promise.all(Array.from({ length: 8 }, (_, i) => postJson(B, '/api/aktivitet', { team: 'tomhol', agent: i % 2 ? 'signal-tuner' : 'main', verktyg: 'edit', mal: `src/fil-${i}.js` })));
  assert.ok(svar.every(s => s.status === 202)); assert.equal(svar.filter(s => s.json.dropped).length, 3); ok('aktivitet: max 5 per sekund, överskottet släpps tyst (202)');
  let akt = (await hamta(B, '/api/aktivitet')).json;
  assert.equal(akt.teams.tomhol.perMin, 5); assert.equal(akt.senaste.length, 5); assert.equal(akt.teams.tomhol.verktyg, 'edit');
  assert.ok(akt.teams.tomhol.agenter.main && akt.teams.tomhol.agenter['signal-tuner']); ok('GET /api/aktivitet: senaste per team, perMin, senaste-listan, per agent');
  assert.equal((await postJson(B, '/api/aktivitet', { team: 'tomhol', mal: 'x'.repeat(200), verktyg: 'bash' })).status, 202);
  await vanta(1100);
  await postJson(B, '/api/aktivitet', { team: 'tomhol', verktyg: 'bash', mal: 'y'.repeat(200) });
  akt = (await hamta(B, '/api/aktivitet')).json; assert.equal(akt.teams.tomhol.mal.length, 60); assert.equal(akt.teams.tomhol.agent, 'main'); ok('aktivitet: mal kapas till 60 tecken, agent blir "main"');
  assert.equal((await postJson(B, '/api/aktivitet', { team: 'tomhol' })).status, 400); ok('aktivitet utan verktyg → 400');
  assert.equal((await hamta(B, '/api/messages?limit=500')).json.length, fore); ok('aktivitet ger inga chattposter');

  // sporer
  x = await postJson(B, '/api/sporer', { fran: 'tomhol', titel: 'Hooks must exit 0', lardom: 'A hook that exits non-zero blocks the agent.\nAlways exit 0.', doman: ['copilot', '#Hooks'], typ: 'fallgrop', kalla: 'tools/agentpuls.sh' });
  assert.equal(x.status, 201); assert.equal(x.json.id, 'square-1'); assert.equal(x.json.etikett, 'pitfall'); assert.deepEqual(x.json.doman, ['copilot', 'hooks']); assert.deepEqual(x.json.integrerad, []);
  ok('POST /api/sporer → square-1');
  let sp = await kanal(B, 'spore'); assert.equal(sp.length, 1); assert.equal(sp[0].from, 'spore'); assert.equal(sp[0].text, 'tomhol shared a pitfall: "Hooks must exit 0" [square-1]'); ok('chattpost i #spore från "spore"');
  x = await postJson(B, '/api/sporer', { from: 'surret', title: 'Small PRs merge faster', lesson: 'Keep each PR to one folder.', type: 'tip', domain: 'git,release' });
  assert.equal(x.status, 201); assert.equal(x.json.typ, 'tips'); assert.equal(x.json.id, 'square-2'); assert.deepEqual(x.json.doman, ['git', 'release']); ok('engelska fält och typer tas också emot');
  x = await postJson(B, '/api/sporer', { fran: 'tomhol', titel: 'x'.repeat(101), lardom: 'y' }); assert.equal(x.status, 400); assert.match(x.json.error, /max 100 characters, got 101/); ok('för lång titel → 400 med förklaring');
  x = await postJson(B, '/api/sporer', { fran: 'tomhol', titel: 'x', lardom: 'y'.repeat(1001) }); assert.equal(x.status, 400); assert.match(x.json.error, /max 1000/); ok('för lång lärdom → 400');
  assert.equal((await postJson(B, '/api/sporer', { fran: 'tomhol', titel: 'x', lardom: 'y', typ: 'rykte' })).status, 400); ok('okänd typ → 400');
  assert.equal((await postJson(B, '/api/sporer', { fran: 'spore', titel: 'x', lardom: 'y' })).status, 400); ok('reserverat namn som avsändare → 400');
  let sl = (await hamta(B, '/api/sporer')).json; assert.equal(sl.hub, null); assert.deepEqual(sl.sporer.map(s => s.id), ['square-1', 'square-2']); ok('GET /api/sporer utan hubb: egna, hub null');
  assert.deepEqual((await hamta(B, '/api/sporer?doman=hooks')).json.sporer.map(s => s.id), ['square-1']); ok('GET /api/sporer?doman=');
  assert.deepEqual((await hamta(B, `/api/sporer?since_ts=${sl.sporer[0].ts}`)).json.sporer.map(s => s.id).includes('square-1'), false); ok('GET /api/sporer?since_ts=');
  x = await postJson(B, '/api/sporer/square-1/integrerad', { team: 'surret', hur: 'Our hook now always exits 0.' });
  assert.equal(x.status, 201); sp = await kanal(B, 'spore'); assert.equal(sp.at(-1).text, 'surret integrated square-1 "Hooks must exit 0": Our hook now always exits 0.'); ok('integrering: 201 och chattpost');
  x = await postJson(B, '/api/sporer/square-1/integrerad', { team: 'surret', hur: 'igen' }); assert.equal(x.status, 200); assert.equal(x.json.duplicate, true); ok('samma team två gånger: ingen dubblett');
  assert.equal((await postJson(B, '/api/sporer/square-99/integrerad', { team: 'surret', hur: 'x' })).status, 404); ok('okänd spore → 404');
  assert.equal((await postJson(B, '/api/sporer/square-1/integrerad', { team: 'surret', hur: 'h'.repeat(301) })).status, 400); ok('för långt hur → 400');
  x = await hamta(B, '/api/sporer/square-1'); assert.equal(x.json.integrerad.length, 1); assert.equal(x.json.integrerad[0].team, 'surret'); ok('GET /api/sporer/<id>');
  assert.match((await hamta(B, '/api/sporer', { headers: { accept: 'text/plain' } })).text, /^\[square-1\] pitfall from tomhol \d\d:\d\d #copilot #hooks\n {2}Hooks must exit 0\n/m); ok('sporer i textformat');
  assert.equal((await hamta(B, '/api/hub/grupper')).status, 404); assert.equal((await postJson(B, '/api/hub/sporer', {})).status, 404); ok('hubbens API finns inte utanför hubben');

  // kolonin: rutor och sidor
  let tl = (await hamta(B, '/api/tiles')).json;
  assert.deepEqual(tl, [
    { team: 'exempelkvarteret', path: 'exempelkvarteret/', url: '/colony/exempelkvarteret/', title: 'Example tile', hero: null, group_app: false },
    { team: 'provappen', path: 'provappen/', url: '/colony/provappen/', title: 'Group app', hero: null, group_app: true },
  ]); ok('GET /api/tiles (group_app ur <meta name="colony" content="group-app">)');
  assert.deepEqual((await hamta(B, '/api/kvarter')).json, ['exempelkvarteret/', 'provappen/']); ok('GET /api/kvarter (gamla formatet)');
  for (const [fran, till] of [['/colony', '/colony/'], ['/staden', '/colony/'], ['/staden/kvarter/exempelkvarteret/', '/colony/exempelkvarteret/'], ['/colony/exempelkvarteret', '/colony/exempelkvarteret/']]) {
    const y = await fetch(B + fran, { redirect: 'manual' }); assert.equal(y.status, 301, fran); assert.equal(y.headers.get('location'), till, fran);
  }
  ok('/colony och /staden leder till /colony/, gamla kvarterslänkar till rutan');
  assert.match((await hamta(B, '/colony/')).text, /The colony/); assert.match((await hamta(B, '/staden')).text, /The colony/); ok('kolonisidan, även via /staden');
  x = await hamta(B, '/colony/exempelkvarteret/'); assert.equal(x.status, 200); assert.match(x.text, /hello/); ok('rutan serveras');
  x = await hamta(B, '/colony/provrutan-dold/'); assert.equal(x.status, 200); assert.match(x.text, /hidden/); ok('en dold ruta (COLONY_HIDE) serveras men listas inte');
  assert.equal((await fetch(B + '/colony/..%2F..%2Fserver.js')).status, 404); assert.equal((await fetch(B + '/colony/exempelkvarteret/..%2F..%2F..%2Fpackage.json')).status, 404); ok('kolonin: ingen path traversal');
  await sidan(B, '/teams', 'teams.html'); await sidan(B, '/lagen', 'teams.html'); ok('/teams (och /lagen)');
  await sidan(B, '/news', 'news.html'); await sidan(B, '/radio', 'radio.html'); await sidan(B, '/nav.js', 'nav.js'); ok('/news, /radio, /nav.js');
  await sidan(B, '/workshop', 'workshop.html');
  await sidan(B, '/workshop/en', existsSync(join(PUB, 'workshop.en.html')) ? 'workshop.en.html' : 'workshop.html'); ok('/workshop och /workshop/en');
  await sidan(B, '/workshop/sv', existsSync(join(PUB, 'workshop.sv.html')) ? 'workshop.sv.html' : 'workshop.html'); ok('/workshop/sv (svenska om den finns)');
  if (existsSync(join(PUB, 'workshop.sv.html'))) {
    // Den engelska är huvudsidan, den svenska ligger bredvid.
    assert.match((await hamta(B, '/workshop')).text, /<html lang="en">/); assert.match((await hamta(B, '/workshop/en')).text, /<html lang="en">/);
    assert.match((await hamta(B, '/workshop/sv')).text, /<html lang="sv">/); ok('workshopsidan: engelska på /workshop och /workshop/en, svenska på /workshop/sv');
  }
  await sidan(B, '/', 'index.html'); await sidan(B, '/square', 'index.html'); await sidan(B, '/torget', 'index.html'); ok('/, /square och /torget (det gamla namnet) är storskärmssidan');

  // nyheter (utan LEAD_TOKEN: öppet)
  x = await postJson(B, '/api/news', { rubrik: 'Morning in the colony', notiser: [{ text: 'tomhol hired a signal tuner.', kallor: [1, 'x', 2] }, 'A plain item'], sammanfattning: 'Busy.' });
  assert.equal(x.status, 201); assert.equal(x.json.nummer, 1); assert.deepEqual(x.json.notiser[0].kallor, [1, 2]); assert.equal(x.json.notiser[1].text, 'A plain item'); ok('POST /api/news → nummer 1');
  let tg = await kanal(B, 'square'); assert.equal(tg.at(-1).from, 'news'); assert.equal(tg.at(-1).text, 'News #1: Morning in the colony (/news)'); ok('kort post i #square från "news"');
  x = await postJson(B, '/api/news', { nummer: 1, rubrik: 'Morning in the colony, corrected' }); assert.equal(x.status, 200);
  assert.equal((await kanal(B, 'square')).length, tg.length); ok('samma nummer igen: rättas, ingen ny post');
  await postJson(B, '/api/news', { rubrik: 'Lunch' });
  let nyh = (await hamta(B, '/api/news')).json; assert.deepEqual(nyh.map(z => z.nummer), [2, 1]); assert.equal(nyh[1].rubrik, 'Morning in the colony, corrected'); ok('GET /api/news: nyast först');
  assert.equal((await hamta(B, '/api/news?limit=1')).json.length, 1); assert.equal((await hamta(B, '/api/news/2')).json.rubrik, 'Lunch'); ok('GET /api/news?limit= och /api/news/<n>');
  assert.equal((await postJson(B, '/api/news', { notiser: [] })).status, 400); ok('nyhet utan rubrik → 400');

  // hero-bilder (utan LEAD_TOKEN: öppet)
  x = await hamta(B, '/api/hero/exempelkvarteret', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  assert.equal(x.status, 201); assert.match(x.json.hero, /^\/hero\/exempelkvarteret\?v=\d+$/); ok('POST /api/hero/<team> (png)');
  x = await hamta(B, '/hero/exempelkvarteret'); assert.equal(x.status, 200); assert.equal(x.headers.get('content-type'), 'image/png'); assert.ok(x.buf.equals(PNG)); assert.match(x.headers.get('cache-control'), /max-age=60/); ok('GET /hero/<team> med kort cache');
  tl = (await hamta(B, '/api/tiles')).json; assert.match(tl[0].hero, /^\/hero\/exempelkvarteret\?v=\d+$/); ok('/api/tiles har hero');
  x = await hamta(B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPG }); assert.equal(x.status, 201);
  lagen = (await hamta(B, '/api/lag')).json; assert.match(lagen.teams.tomhol.hero, /^\/hero\/tomhol\?v=/); assert.equal(lagen.teams.surret.hero, null); ok('/api/lag har hero per team');
  x = await hamta(B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG }); assert.equal(x.status, 201);
  assert.equal((await hamta(B, '/hero/tomhol')).headers.get('content-type'), 'image/png'); assert.ok(!existsSync(join(dir, 'heroes', 'tomhol.jpg'))); ok('ny bild med annat format ersätter den gamla');
  assert.equal((await hamta(B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: Buffer.concat([JPG, Buffer.alloc(1.6 * 1024 * 1024)]) })).status, 413); ok('för stor bild → 413');
  assert.equal((await hamta(B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hej' })).status, 415); ok('fel content-type → 415');
  assert.equal((await hamta(B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/png' }, body: JPG })).status, 415); ok('jpeg-bytes som image/png → 415');
  assert.equal((await hamta(B, '/api/hero/' + encodeURIComponent('../x'), { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })).status, 400); ok('ogiltigt teamnamn → 400');
  assert.equal((await hamta(B, '/hero/finns-inte')).status, 404); ok('ingen hero → 404');

  // radio (lokal: det här är som hubben)
  x = await hamta(B, '/api/radio'); assert.equal(x.status, 404); assert.equal(x.json.on_air, false); ok('ingen lista.json → 404 on_air false');
  mkdirSync(join(dir, 'radio', 'sandningar'), { recursive: true });
  const LJUD = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  writeFileSync(join(dir, 'radio', 'sandningar', 'morgon 1.mp3'), LJUD);
  writeFileSync(join(dir, 'radio', 'sting.mp3'), Buffer.alloc(10, 1));
  writeFileSync(join(dir, 'radio', 'lista.json'), JSON.stringify({ station: 'Square FM', sandningar: [{ titel: 'Morning', fil: 'sandningar/morgon 1.mp3' }], sting: 'sting.mp3', extern: 'https://example.com/x.mp3', redan: '/radio/fil/sting.mp3' }));
  x = await hamta(B, '/api/radio'); assert.equal(x.status, 200);
  assert.equal(x.json.sandningar[0].fil, '/radio/fil/sandningar/morgon%201.mp3'); assert.equal(x.json.sting, '/radio/fil/sting.mp3'); assert.equal(x.json.extern, 'https://example.com/x.mp3'); assert.equal(x.json.redan, '/radio/fil/sting.mp3'); assert.equal(x.json.station, 'Square FM');
  ok('GET /api/radio: relativa ljudfiler blir /radio/fil/...');
  x = await hamta(B, '/radio/fil/sandningar/morgon%201.mp3'); assert.equal(x.status, 200); assert.equal(x.headers.get('accept-ranges'), 'bytes'); assert.equal(x.headers.get('content-type'), 'audio/mpeg'); assert.ok(x.buf.equals(LJUD)); ok('GET /radio/fil/<sökväg>');
  x = await hamta(B, '/radio/fil/sandningar/morgon%201.mp3', { headers: { range: 'bytes=100-199' } });
  assert.equal(x.status, 206); assert.equal(x.headers.get('content-range'), 'bytes 100-199/1000'); assert.equal(x.buf.length, 100); assert.equal(x.buf[0], 100); ok('Range: bytes=100-199 → 206');
  x = await hamta(B, '/radio/fil/sandningar/morgon%201.mp3', { headers: { range: 'bytes=-10' } }); assert.equal(x.status, 206); assert.equal(x.buf.length, 10); assert.equal(x.headers.get('content-range'), 'bytes 990-999/1000'); ok('Range: bytes=-10 (slutet)');
  x = await hamta(B, '/radio/fil/sandningar/morgon%201.mp3', { headers: { range: 'bytes=900-' } }); assert.equal(x.status, 206); assert.equal(x.buf.length, 100); ok('Range: bytes=900-');
  assert.equal((await hamta(B, '/radio/fil/sting.mp3', { headers: { range: 'bytes=5000-' } })).status, 416); ok('Range utanför filen → 416');
  assert.equal((await fetch(B + '/radio/fil/..%2Flag.json')).status, 404); assert.equal((await fetch(B + '/radio/fil/..%2F..%2Fetc%2Fpasswd')).status, 404); ok('radio: ingen path traversal');

  // XFF: ratelimiten nycklas på det SISTA värdet (det Caddy satt), inte det klienten själv skriver först
  let sista = 0;
  for (let i = 0; i < 61; i++) {
    const y = await post({ from: 'flodare', channel: 'flood', text: `inlägg ${i}` }, { 'x-forwarded-for': `spoofed-${i}, client-seen-by-caddy` });
    sista = y.status;
  }
  assert.equal(sista, 429); ok('ratelimit går inte att kringgå med en egen X-Forwarded-For');

  await S.stoppa();

  del('3. Kolonin berättar själv när något nytt dykt upp');
  const kd = tmp('kd'), kc = tmp('kc'), kp = tmp('kp');
  mkdirSync(join(kc, 'alfa'), { recursive: true }); writeFileSync(join(kc, 'alfa', 'index.html'), '<title>Alfa</title>v1');
  const KM = { DATA_DIR: kd, COLONY_DIR: kc, PLUGINS_DIR: kp, PUBLIC_URL: 'https://backend.example.com/' };
  S = await starta(KM, 'koloni-1');
  assert.equal((await kanal(S.B, 'build')).length, 0); assert.ok(existsSync(join(kd, 'colony-state.json'))); ok('första starten någonsin: inget postas, läget sparas');
  await S.stoppa(); S = await starta(KM, 'koloni-2');
  assert.equal((await kanal(S.B, 'build')).length, 0); ok('omstart utan ändringar: inget postas');
  await S.stoppa();
  writeFileSync(join(kc, 'alfa', 'index.html'), '<title>Alfa</title>v2');
  mkdirSync(join(kc, 'beta'), { recursive: true }); writeFileSync(join(kc, 'beta', 'index.html'), '<title>Beta</title>'); writeFileSync(join(kc, 'beta', 'style.css'), 'p{}');
  mkdirSync(join(kp, 'beta'), { recursive: true }); writeFileSync(join(kp, 'beta', 'index.js'), 'module.exports = {};\n');
  mkdirSync(join(kp, 'gamma'), { recursive: true }); writeFileSync(join(kp, 'gamma', 'index.js'), 'module.exports = {};\n');
  S = await starta(KM, 'koloni-3');
  let bygg = await kanal(S.B, 'build');
  assert.deepEqual(bygg.map(m => m.from), ['colony', 'colony', 'colony']);
  assert.deepEqual(bygg.map(m => m.text), [
    '@alfa your update is live in the colony',
    '@beta your tile is live in the colony: https://backend.example.com/colony/beta/',
    '@gamma your backend is live in the colony: https://backend.example.com/t/gamma/',
  ]);
  ok('ny ruta, ändrad ruta och nytt plugin: en post var i #build från "colony"');
  assert.equal((await hamta(S.B, '/api/messages?mention=beta')).json.length, 1); ok('posten når teamet via @-nämning');
  await S.stoppa(); S = await starta(KM, 'koloni-4');
  assert.equal((await kanal(S.B, 'build')).length, 3); ok('ingen upprepning vid nästa omstart');
  await S.stoppa();
  writeFileSync(join(kp, 'gamma', 'index.js'), 'module.exports = { init() {} };\n');
  S = await starta({ ...KM, PUBLIC_URL: '' }, 'koloni-5');
  bygg = await kanal(S.B, 'build'); assert.equal(bygg.at(-1).text, '@gamma your update is live in the colony'); ok('ändrat plugin utan ruta: "your update is live"');
  await S.stoppa();
  mkdirSync(join(kc, 'delta'), { recursive: true }); writeFileSync(join(kc, 'delta', 'index.html'), '<title>Delta</title>');
  S = await starta({ ...KM, PUBLIC_URL: '' }, 'koloni-6');
  bygg = await kanal(S.B, 'build'); assert.equal(bygg.at(-1).text, '@delta your tile is live in the colony: /colony/delta/'); ok('utan PUBLIC_URL: relativ länk');
  await S.stoppa();
  writeFileSync(join(kd, 'colony-state.json'), '{trasig');
  writeFileSync(join(kc, 'alfa', 'index.html'), '<title>Alfa</title>v3');
  S = await starta(KM, 'koloni-7');
  assert.equal((await kanal(S.B, 'build')).length, bygg.length); ok('trasig state-fil räknas som första start: ingen spam');
  await S.stoppa();

  del('4. En grupp och en hubb');
  const LEAD = 'provnyckel-123';
  const hubPort = await ledigPort(), grpPort = await ledigPort();
  const tom = () => tmp('tom');
  const hd = tmp('hub'), gd = tmp('grupp');
  const HM = {
    PORT: String(hubPort), DATA_DIR: hd, HUB: '1', PUBLIC_URL: 'https://example.com', LEAD_TOKEN: LEAD, HUB_POLL_MS: '300', PLUGINS_DIR: tom(), COLONY_DIR: tom(),
    GRUPPER: JSON.stringify([{ id: 'backend', namn: 'BackEnd', url: 'https://backend.example.com', intern: `http://127.0.0.1:${grpPort}` }, { id: 'saknas', namn: 'Missing', url: 'https://missing.example.com', intern: 'http://127.0.0.1:9' }]),
  };
  const GM = {
    PORT: String(grpPort), DATA_DIR: gd, GRUPP: 'backend', GRUPP_NAMN: 'BackEnd', HUB_URL: `http://127.0.0.1:${hubPort}/`, HUB_PUBLIC_URL: 'https://example.com', PUBLIC_URL: 'https://backend.example.com',
    LEAD_TOKEN: LEAD, SPORE_CACHE_MS: '200', HUB_RETRY_MS: '300', EVO_CHAT_MS: '1500', PLUGINS_DIR: tom(), COLONY_DIR: tom(),
  };
  // gruppen startar först, medan hubben är nere
  let G = await starta(GM, 'grupp');
  hh = (await hamta(G.B, '/api/health')).json;
  assert.equal(hh.mode, 'group'); assert.equal(hh.grupp, 'backend'); assert.equal(hh.grupp_namn, 'BackEnd'); assert.equal(hh.hub, false); assert.equal(hh.hub_url, 'https://example.com'); assert.equal(hh.public_url, 'https://backend.example.com');
  ok('health på en grupp: grupp, grupp_namn, hub false, hub_url publik');
  x = await postJson(G.B, '/api/sporer', { fran: 'tomhol', titel: 'Copilot hooks need exit 0', lardom: 'Or the agent stops.' });
  assert.equal(x.status, 201); assert.equal(x.json.id, 'backend-1'); assert.equal(x.json.grupp, 'backend'); ok('spore på gruppen medan hubben är nere: 201, id backend-1');
  sl = (await hamta(G.B, '/api/sporer')).json; assert.equal(sl.hub, false); assert.deepEqual(sl.sporer.map(s => s.id), ['backend-1']); ok('hubben nere: bara egna och "hub": false');
  x = await postJson(G.B, '/api/sporer/frontend1-9/integrerad', { team: 'tomhol', hur: 'Tried it.' }); assert.equal(x.status, 201); assert.equal(x.json.hub, false); ok('integrering av en annan grupps spore medan hubben är nere: tas emot');

  let H = await starta(HM, 'hubb');
  let hs = await tills(async () => { const l = (await hamta(H.B, '/api/sporer')).json; return l.sporer.some(s => s.id === 'backend-1') && l; }, 5000, 'att sporen når hubben');
  assert.equal(hs.hub, true); assert.equal(hs.sporer.find(s => s.id === 'backend-1').grupp_namn, 'BackEnd'); ok('utkorgen levererar till hubben när den kommer upp');
  sp = await kanal(H.B, 'spore'); assert.equal(sp[0].from, 'spore'); assert.equal(sp[0].text, 'tomhol (BackEnd) shared a tip: "Copilot hooks need exit 0" [backend-1]'); ok('hubben postar sporen i sin #spore, med gruppens namn');
  hh = (await hamta(H.B, '/api/health')).json; assert.equal(hh.mode, 'hub'); assert.equal(hh.hub, true); assert.equal(hh.hub_url, 'https://example.com'); ok('health på hubben');
  x = await postJson(H.B, '/api/sporer', { fran: 'plenum', titel: 'Name your interfaces early', lardom: 'Agree on the JSON before you build.', typ: 'monster' });
  assert.equal(x.json.id, 'square-1'); ok('spore direkt på hubben: square-1');
  sl = await tills(async () => { const l = (await hamta(G.B, '/api/sporer')).json; return l.hub && l.sporer.length === 2 && l; }, 3000, 'sammanslagen lista');
  assert.deepEqual(sl.sporer.map(s => s.id).sort(), ['backend-1', 'square-1']); ok('gruppens GET /api/sporer slår ihop hubbens (alla=1 är standard)');
  sl = (await hamta(G.B, '/api/sporer?alla=0')).json; assert.equal(sl.hub, null); assert.deepEqual(sl.sporer.map(s => s.id), ['backend-1']); ok('alla=0: bara egna');
  x = await postJson(G.B, '/api/sporer/square-1/integrerad', { team: 'tomhol', hur: 'We wrote the contract first.' }); assert.equal(x.status, 201);
  assert.equal((await kanal(G.B, 'spore')).at(-1).text, 'tomhol integrated square-1 "Name your interfaces early": We wrote the contract first.');
  await tills(async () => (await hamta(H.B, '/api/sporer/square-1')).json.integrerad.some(i => i.team === 'tomhol' && i.grupp === 'backend'), 3000, 'integreringen på hubben');
  ok('integrering av hubbens spore vidarebefordras');
  assert.match((await kanal(H.B, 'spore')).at(-1).text, /^tomhol \(BackEnd\) integrated square-1/); ok('hubben postar integreringen');
  assert.equal((await postJson(G.B, '/api/sporer/nope-5/integrerad', { team: 'tomhol', hur: 'x' })).status, 404); ok('id som varken gruppen eller hubben känner → 404');
  x = await postJson(H.B, '/api/hub/sporer', { integreringar: [{ id: 'backend-1', team: 'surret', grupp: 'frontend1', grupp_namn: 'FrontEnd 1', hur: 'Used it in our hook.', ts: Date.now() }] });
  assert.equal(x.status, 200); assert.equal(x.json.nya_integreringar, 1);
  await tills(async () => (await hamta(G.B, '/api/sporer')).json.sporer.find(s => s.id === 'backend-1').integrerad.some(i => i.team === 'surret'), 3000, 'andra gruppens integrering hos gruppen');
  ok('en annan grupps integrering av vår spore syns hos oss via hubben');
  assert.equal((await postJson(H.B, '/api/hub/sporer', { sporer: [] }, { 'x-forwarded-for': 'client-via-caddy' })).status, 403); ok('POST /api/hub/sporer via proxy (X-Forwarded-For) → 403');
  const hubSporePoster = (await kanal(H.B, 'spore')).length;
  await G.stoppa(); G = await starta(GM, 'grupp-2');
  await vanta(800);
  assert.equal((await kanal(H.B, 'spore')).length, hubSporePoster); assert.equal((await hamta(H.B, '/api/sporer')).json.sporer.filter(s => s.id === 'backend-1').length, 1); ok('gruppen skickar om allt efter omstart, hubben gör inga dubbletter');

  // hubbens översikt
  await postJson(G.B, '/api/lag', { team: 'tomhol', lab: 'factory', roster: { agents: ['ceo'] } });
  await postJson(G.B, '/api/messages', { from: 'tomhol', channel: 'help', text: 'How do we deploy?' });
  await postJson(G.B, '/api/aktivitet', { team: 'tomhol', verktyg: 'bash' });
  const gr = await tills(async () => { const l = (await hamta(H.B, '/api/hub/grupper')).json; const b = l.find(z => z.id === 'backend'); return b && b.ok && b.teams.length === 1 && b.help_obesvarade === 1 && l; }, 5000, 'hubbens poll');
  const b = gr.find(z => z.id === 'backend');
  assert.equal(b.namn, 'BackEnd'); assert.equal(b.url, 'https://backend.example.com'); assert.deepEqual(b.teams, ['tomhol']); assert.equal(b.labs.tomhol, 'factory');
  assert.equal(b.sporer, 1); assert.equal(b.evolution.length, 1); assert.match(b.evolution[0].text, /^tomhol came online/); assert.ok(b.messages >= 1); assert.ok(b.senaste_ts > 0); assert.equal(b.aktiva_team, 1);
  ok('GET /api/hub/grupper: teams, evolution, sporer, help_obesvarade, aktiva_team');
  assert.equal(gr.find(z => z.id === 'saknas').ok, false); ok('en grupp som inte svarar: ok false, hubben lever');
  await sidan(H.B, '/square', 'index.html'); await sidan(H.B, '/torget', 'index.html'); await sidan(H.B, '/', existsSync(join(PUB, 'hub.html')) ? 'hub.html' : 'index.html'); ok('hubben: / är hub.html, /square (och /torget) storskärmssidan');

  // ledarens nyckel
  assert.equal((await postJson(G.B, '/api/messages', { from: 'release', channel: 'build', text: 'merged' })).status, 403);
  assert.equal((await postJson(G.B, '/api/messages', { from: 'release', channel: 'build', text: 'merged' }, { 'x-lead-token': 'fel' })).status, 403);
  assert.equal((await postJson(G.B, '/api/messages', { from: 'release', channel: 'build', text: 'merged' }, { 'x-lead-token': LEAD })).status, 201);
  assert.equal((await postJson(G.B, '/api/messages', { from: 'lead', text: '@tomhol quiet for 15 minutes?' }, { 'x-lead-token': LEAD })).status, 201);
  ok('med LEAD_TOKEN: release och lead kräver rätt x-lead-token');
  assert.equal((await postJson(G.B, '/api/messages', { from: 'radio', text: 'now playing' }, { 'x-lead-token': LEAD })).status, 201);
  assert.equal((await postJson(G.B, '/api/messages', { from: 'evolution', text: 'fejk' }, { 'x-lead-token': LEAD })).status, 403); ok('nyckeln öppnar hub/news/radio men aldrig evolution/spore/colony');
  assert.equal((await postJson(G.B, '/api/news', { rubrik: 'x' })).status, 403);
  x = await postJson(G.B, '/api/news', { rubrik: 'BackEnd at noon' }, { 'x-lead-token': LEAD }); assert.equal(x.status, 201);
  assert.equal((await kanal(G.B, 'square')).at(-1).text, 'News #1: BackEnd at noon (https://backend.example.com/news)'); ok('POST /api/news kräver nyckeln; länken använder PUBLIC_URL');
  // gruppens anteckningar (nycklar på workshopsidan)
  assert.deepEqual((await hamta(G.B, '/api/notes')).json, { notes: null, ts: null }); ok('GET /api/notes utan anteckningar: null');
  assert.equal((await hamta(G.B, '/api/notes', { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: '## Keys' })).status, 403);
  assert.equal((await hamta(G.B, '/api/notes', { method: 'POST', headers: { 'content-type': 'text/markdown', 'x-lead-token': 'fel' }, body: '## Keys' })).status, 403);
  x = await hamta(G.B, '/api/notes', { method: 'POST', headers: { 'content-type': 'text/markdown', 'x-lead-token': LEAD }, body: '## Your keys\n- ResRobot: `abc123`\n' });
  assert.equal(x.status, 200); assert.equal((await hamta(G.B, '/api/notes')).json.notes, '## Your keys\n- ResRobot: `abc123`\n'); ok('POST /api/notes kräver nyckeln, GET visar texten');
  assert.equal((await hamta(G.B, '/api/notes', { method: 'POST', headers: { 'x-lead-token': LEAD }, body: 'x'.repeat(21 * 1024) })).status, 413); ok('för långa anteckningar → 413');
  await hamta(G.B, '/api/notes', { method: 'POST', headers: { 'x-lead-token': LEAD }, body: '  ' }); assert.equal((await hamta(G.B, '/api/notes')).json.notes, null); ok('tom POST tar bort anteckningarna');
  assert.equal((await hamta(G.B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })).status, 403);
  assert.equal((await hamta(G.B, '/api/hero/tomhol', { method: 'POST', headers: { 'content-type': 'image/png', 'x-lead-token': LEAD }, body: PNG })).status, 201); ok('POST /api/hero kräver nyckeln');

  // radion spelas från hubben
  assert.equal((await hamta(G.B, '/api/radio')).status, 404); ok('gruppens radio när hubben inte har någon: 404');
  mkdirSync(join(hd, 'radio', 'sandningar'), { recursive: true });
  writeFileSync(join(hd, 'radio', 'sandningar', 'a.mp3'), Buffer.alloc(50, 3));
  writeFileSync(join(hd, 'radio', 'lista.json'), JSON.stringify({ spellista: ['sandningar/a.mp3', '/radio/fil/sting.mp3'] }));
  assert.deepEqual((await hamta(H.B, '/api/radio')).json.spellista, ['/radio/fil/sandningar/a.mp3', '/radio/fil/sting.mp3']); ok('hubbens /api/radio');
  x = await tills(async () => { const y = await hamta(G.B, '/api/radio'); return y.status === 200 && y; }, 7000, 'gruppens radiocache');
  assert.deepEqual(x.json.spellista, ['https://example.com/radio/fil/sandningar/a.mp3', 'https://example.com/radio/fil/sting.mp3']); ok('gruppens /api/radio hämtas från hubben med hubbens publika adress');
  await H.stoppa();
  await vanta(5200);
  x = await hamta(G.B, '/api/radio'); assert.equal(x.status, 502); assert.equal(x.json.on_air, false); ok('hubben nere: gruppens radio svarar 502, ingen krasch');
  sl = (await hamta(G.B, '/api/sporer')).json; assert.equal(sl.hub, false); ok('hubben nere: sporer svarar ändå');
  await G.stoppa();

  console.log(`\n${n} tester gröna`);
  process.exit(0);
} catch (e) {
  console.error('\n✗', e.stack || e.message);
  if (logg.trim()) console.error('serverloggen:\n' + logg.split('\n').slice(-40).join('\n'));
  for (const p of igang) p.kill();
  process.exit(1);
}
