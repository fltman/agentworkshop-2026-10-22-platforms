// NodeLink dashboard (team anders). Reads Node (farzad) and Gateway (pisak) state and events, see
// projects/anders/CONTRACT.md. Falls back to the demo simulator in sim.js while farzad is unreachable.
const $ = s => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const W = 520, H = 380, CX = W / 2, CY = H / 2, R = 150;

const SRC = {
  farzad: { label: 'Node (farzad)', base: '/t/farzad/api', live: false, fails: 0 },
  pisak: { label: 'Gateway (pisak)', base: '/t/pisak/api', live: false, fails: 0 },
  control: { label: 'Control (platforms-tp)', base: '/t/platforms-tp/api', live: false, fails: 0 },
};
let demo = false, sim = null;
const since = { farzad: 0, pisak: 0 }, primed = { farzad: false, pisak: false };
const model = { mode: '-', switching: false, nodes: [], links: [], possibleLinks: 0, openConnections: 0,
  metrics: { mesh: {}, gateway: {} }, gw: null, gwMetrics: null };
const conns = { mesh: null, gateway: null };
const pos = {};
let selected = null;

async function fetchJSON(url, method = 'GET', body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(url, { method, signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = data.error || {};
      throw new Error(`${r.status} ${e.code || ''} ${e.message || (typeof data.error === 'string' ? data.error : '')}`.trim());
    }
    return data;
  } finally { clearTimeout(timer); }
}

function mark(name, ok) {
  const s = SRC[name];
  s.live = ok;
  s.fails = ok ? 0 : s.fails + 1;
}

// Both teams' events are mapped to one shape: { id, ts, type, from, to, ok, latencyMs, errorCode, mode, ... }.
// farzad already sends type like "message.request"; pisak sends kind "message" + type "request", or kind "node-down".
function norm(e, src) {
  let type = e.type || '';
  if (!type.includes('.') && e.kind) type = e.kind === 'message' ? 'message.' + (e.type || 'request') : e.kind.replace('-', '.');
  return { ...e, id: e.id != null && String(e.id).includes('-') ? e.id : src + '-' + (e.seq ?? e.id), type, src };
}

async function pollState() {
  try {
    const s = await fetchJSON(SRC.farzad.base + '/state');
    mark('farzad', true);
    if (demo) { demo = false; since.farzad = 0; primed.farzad = false; say('Node module is live, left demo mode'); }
    apply(s);
  } catch {
    mark('farzad', false);
    if (!demo && SRC.farzad.fails >= 2) { demo = true; sim = sim || createSim(); }
  }
  if (demo) {
    apply(sim.state());
    model.gw = sim.gwState(); model.gwMetrics = null;
  } else {
    try {
      const [s, m] = await Promise.all([fetchJSON(SRC.pisak.base + '/state'),
        fetchJSON(SRC.pisak.base + '/metrics').catch(() => null)]);
      mark('pisak', true); model.gw = s; model.gwMetrics = m;
    } catch { mark('pisak', false); model.gw = null; model.gwMetrics = null; }
  }
  fetchJSON(SRC.control.base + '/state').then(() => mark('control', true), () => mark('control', false));
  render();
}

function apply(s) {
  Object.assign(model, { mode: s.mode || '-', switching: !!s.switching, nodes: s.nodes || [], links: s.links || [],
    possibleLinks: s.possibleLinks ?? 0, openConnections: s.openConnections ?? s.connections ?? 0,
    metrics: s.metrics || { mesh: {}, gateway: {} } });
  if (model.mode === 'mesh' || model.mode === 'gateway')
    conns[model.mode] = { open: model.openConnections, possible: model.possibleLinks };
}

async function pollEvents() {
  if (demo) { sim.drain().forEach(e => onEvent(norm(e, 'farzad'))); return; }
  for (const src of ['farzad', 'pisak']) {
    if (!SRC[src].live) continue;
    try {
      for (let i = 0, more = true; more && i < 5; i++) {
        const r = await fetchJSON(`${SRC[src].base}/events?since=${since[src]}`);
        if (r.seq != null && r.seq < since[src]) { since[src] = 0; break; }
        if (primed[src]) (r.events || []).forEach(e => onEvent(norm(e, src)));
        if (r.seq != null) since[src] = r.seq;
        more = !!r.more && primed[src];
      }
      primed[src] = true;
    } catch { /* state polling marks the source down */ }
  }
}

function onEvent(e) {
  if (e.type.startsWith('message.')) {
    // In gateway mode both farzad and pisak report each message: animate farzad's, pisak's only without farzad.
    if (e.src === 'farzad' || !SRC.farzad.live) animate(e);
    return;
  }
  log(e);
}

// ---------- topology ----------
const el = (tag, attrs, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const LINK_RANK = { reachable: 3, initializing: 2, restarting: 1, unreachable: 0 };
const LINK_COLOR = { 3: '#2f6f5a', 2: '#ffb454', 1: '#ffb454', 0: '#ff6b6b' };

function layout() {
  const n = model.nodes.length;
  model.nodes.forEach((node, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1);
    pos[node.nodeId] = { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  });
  pos.gateway = { x: CX, y: CY };
}

function renderTopology() {
  layout();
  const links = $('#links'), nodesG = $('#nodes');
  links.replaceChildren(); nodesG.replaceChildren();
  const gwMode = model.mode === 'gateway';
  if (!gwMode) {
    const pairs = {};
    for (const l of model.links) {
      if (l.to === 'gateway' || !(l.state in LINK_RANK)) continue;
      const k = [l.from, l.to].sort().join('|');
      pairs[k] = Math.min(pairs[k] ?? 3, LINK_RANK[l.state]);
    }
    for (const k in pairs) {
      const [a, b] = k.split('|');
      if (!pos[a] || !pos[b]) continue;
      el('line', { x1: pos[a].x, y1: pos[a].y, x2: pos[b].x, y2: pos[b].y, stroke: LINK_COLOR[pairs[k]],
        'stroke-width': 1, 'stroke-opacity': pairs[k] === 3 ? 0.45 : 0.9, 'stroke-dasharray': pairs[k] === 0 ? '4 4' : '' }, links);
    }
  } else {
    for (const l of model.links) {
      if (l.to !== 'gateway' || !pos[l.from]) continue;
      const rank = LINK_RANK[l.state ?? (l.status === 'up' ? 'reachable' : 'unreachable')] ?? 0;
      el('line', { x1: pos[l.from].x, y1: pos[l.from].y, x2: CX, y2: CY, stroke: LINK_COLOR[rank], 'stroke-width': 1.5,
        'stroke-dasharray': rank === 0 ? '4 4' : '' }, links);
    }
  }
  const gwStatus = model.gw?.gateway?.status;
  const gwColor = gwStatus === 'down' ? '#ff6b6b' : gwStatus === 'up' ? '#7aa2ff' : '#3a4560';
  el('rect', { x: CX - 34, y: CY - 16, width: 68, height: 32, rx: 6, fill: '#0c1324', stroke: gwColor,
    'stroke-width': 2, opacity: gwMode ? 1 : 0.35 }, nodesG);
  el('text', { x: CX, y: CY + 4, 'text-anchor': 'middle', fill: gwColor, 'font-size': 11, opacity: gwMode ? 1 : 0.5 }, nodesG)
    .textContent = gwStatus === 'down' ? 'GW DOWN' : 'gateway';

  const gwNodes = Object.fromEntries((model.gw?.nodes || []).map(n => [n.nodeId, n]));
  for (const n of model.nodes) {
    const p = pos[n.nodeId], g = gwNodes[n.nodeId] || {};
    const slow = (n.chaos?.delayMs || 0) > 0 || g.status === 'slow';
    const fill = n.status === 'up' ? '#5fd7a7' : n.status === 'down' ? '#ff6b6b' : '#ffb454';
    const grp = el('g', { style: 'cursor:pointer', opacity: n.messaging === 'disabled' ? 0.55 : 1 }, nodesG);
    grp.addEventListener('click', () => { selected = n.nodeId; render(); });
    el('circle', { cx: p.x, cy: p.y, r: 15, fill: '#0c1324', stroke: fill, 'stroke-width': 3,
      'stroke-dasharray': (n.chaos?.dropPercent || 0) > 0 ? '5 3' : '' }, grp);
    if (slow) el('circle', { cx: p.x, cy: p.y, r: 20, fill: 'none', stroke: '#ff9f43', 'stroke-width': 1.5 }, grp);
    if (selected === n.nodeId) el('circle', { cx: p.x, cy: p.y, r: 24, fill: 'none', stroke: '#fff', 'stroke-width': 1 }, grp);
    el('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', fill: '#e9eef7', 'font-size': 11 }, grp).textContent = n.nodeId;
    if (g.circuit && g.circuit !== 'closed')
      el('text', { x: p.x, y: p.y - 22, 'text-anchor': 'middle', fill: '#c792ea', 'font-size': 10 }, grp).textContent = 'circuit ' + g.circuit;
    el('title', {}, grp).textContent =
      `${n.nodeId}: ${n.status}, messaging ${n.messaging || '-'}` + (g.circuit ? `, circuit ${g.circuit}` : '') +
      (slow ? ', slow' : '') + ((n.chaos?.dropPercent || 0) > 0 ? `, drop ${n.chaos.dropPercent}%` : '');
  }
}

// ---------- message flow ----------
const flying = [];
function animate(e) {
  if (flying.length > 150 || !pos[e.from]) return;
  const targets = e.to === '*' ? model.nodes.map(n => n.nodeId).filter(id => id !== e.from) : [e.to];
  const viaGw = (e.mode || model.mode) === 'gateway';
  for (const t of targets) {
    if (!pos[t]) continue;
    const path = viaGw ? [pos[e.from], pos.gateway, pos[t]] : [pos[e.from], pos[t]];
    const dot = el('circle', { r: e.to === '*' ? 2.5 : 3.5, fill: e.ok === false ? '#ff6b6b' : '#ffe08a' }, $('#flow'));
    flying.push({ dot, path, start: performance.now(), dur: 700 });
  }
}
function frame(t) {
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i], k = (t - f.start) / f.dur;
    if (k >= 1) { f.dot.remove(); flying.splice(i, 1); continue; }
    const segs = f.path.length - 1, s = Math.min(segs - 1, Math.floor(k * segs)), u = k * segs - s;
    const a = f.path[s], b = f.path[s + 1];
    f.dot.setAttribute('cx', a.x + (b.x - a.x) * u);
    f.dot.setAttribute('cy', a.y + (b.y - a.y) * u);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- metrics ----------
const fmt = {
  ms: v => v == null ? 'n/a' : Math.round(v) + ' ms',
  rate: v => v == null ? 'n/a' : (+v).toFixed(1) + '/s',
  pct: v => v == null ? 'n/a' : (v * 100).toFixed(1) + '%',
};
function renderMetrics() {
  // A mode without traffic in the window has no meaningful latency or error rate: show n/a, not 0.
  const idle = m => (m.throughputPerSec ?? 0) > 0 ? m : { ...m, p50Ms: null, p95Ms: null, errorRate: null };
  const mesh = idle(model.metrics.mesh || {});
  const gw = idle(model.gwMetrics || model.gw?.metrics || model.metrics.gateway || {});
  const c = m => conns[m] ? `${conns[m].open} / ${conns[m].possible}` : 'n/a';
  const rows = [
    ['Latency p50', mesh.p50Ms, gw.p50Ms, fmt.ms, 'low'],
    ['Latency p95', mesh.p95Ms, gw.p95Ms, fmt.ms, 'low'],
    ['Throughput', mesh.throughputPerSec, gw.throughputPerSec, fmt.rate, null],
    ['Error rate', mesh.errorRate, gw.errorRate, fmt.pct, 'low'],
    ['Open connections', conns.mesh?.open, conns.gateway?.open, null, 'low', c('mesh'), c('gateway')],
    ['Failure detection', mesh.detectMs, gw.detectMs, fmt.ms, 'low'],
  ];
  const head = `<tr><th></th><th class="${model.mode === 'mesh' ? 'active' : ''}">Mesh</th>` +
    `<th class="${model.mode === 'gateway' ? 'active' : ''}">Gateway</th></tr>`;
  $('#metrics').innerHTML = head + rows.map(([name, a, b, f, better, ta, tb]) => {
    const both = a != null && b != null && (a || b) && better;
    const win = both ? (a < b ? 'a' : b < a ? 'b' : '') : '';
    return `<tr><td>${name}</td><td class="${win === 'a' ? 'win' : ''}">${ta ?? f(a)}</td>` +
      `<td class="${win === 'b' ? 'win' : ''}">${tb ?? f(b)}</td></tr>`;
  }).join('');
}

function renderBadges() {
  const b = Object.entries(SRC).map(([k, s]) => {
    const st = demo && k !== 'control' ? 'demo' : s.live ? 'live' : 'down';
    return `<span class="badge ${st === 'demo' ? '' : st}">${s.label}: ${st}</span>`;
  });
  if (demo) b.unshift('<span class="badge demo">DEMO DATA</span>');
  $('#badges').innerHTML = b.join('');
  $('#mode').textContent = model.mode + (model.switching ? ' (switching)' : '');
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === model.mode));
  if (selected && !model.nodes.some(n => n.nodeId === selected)) selected = null;
  $('#sel').textContent = selected ? 'target: ' + selected : 'no node selected';
}

function render() { renderBadges(); renderTopology(); renderMetrics(); }

// ---------- event log ----------
function log(e) {
  const d = new Date(e.ts || Date.now()).toTimeString().slice(0, 8);
  const parts = [e.type, e.to && e.to !== '*' ? e.to : '', e.from ? `(by ${e.from})` : '',
    e.detectMs != null ? `detected in ${e.detectMs} ms` : '', e.action || '', e.errorCode || ''].filter(Boolean);
  const div = document.createElement('div');
  div.className = e.ok === false ? 'bad' : e.ok === true ? 'good' : '';
  div.textContent = `${d} ${parts.join(' ')}`;
  const box = $('#log');
  box.prepend(div);
  while (box.childElementCount > 60) box.lastChild.remove();
}

// ---------- controls ----------
function say(msg, err) { const s = $('#say'); s.textContent = msg; s.className = err ? 'err' : ''; }
async function call(target, method, path, body) {
  try {
    if (demo) sim.handle(target, method, path, body);
    else await fetchJSON(SRC[target].base + path, method, body);
    say(`${method} ${SRC[target].base}${path} ok${demo ? ' (demo)' : ''}`);
  } catch (err) { say(`${method} ${SRC[target].base}${path} failed: ${err.message}`, true); }
  pollState();
}
const needNode = () => { if (!selected) say('Click a node first', true); return selected; };
const trafficBody = () => {
  const r = +$('#mixReq').value, o = +$('#mixOne').value, b = +$('#mixB').value, sum = r + o + b || 1;
  return { rate: +$('#rate').value, mix: { request: r / sum, oneway: o / sum, broadcast: b / sum }, payloadBytes: +$('#payload').value };
};

document.querySelectorAll('[data-mode]').forEach(b =>
  b.addEventListener('click', () => call('farzad', 'POST', '/mode', { mode: b.dataset.mode })));
$('#reset').addEventListener('click', () =>
  call('farzad', 'POST', '/reset', { nodes: +$('#nodeCount').value, mode: model.mode === 'gateway' ? 'gateway' : 'mesh' }));
$('#add').addEventListener('click', () => call('farzad', 'POST', '/nodes', { count: 1, external: false }));
$('#remove').addEventListener('click', () => needNode() && call('farzad', 'DELETE', '/nodes/' + selected));
$('#rate').addEventListener('input', () => { $('#rateVal').textContent = $('#rate').value; });
$('#traffic').addEventListener('click', () => call('farzad', 'POST', '/traffic', trafficBody()));
$('#stop').addEventListener('click', () => call('farzad', 'POST', '/traffic', { rate: 0 }));
const CHAOS = { kill: {}, revive: {}, slow: { delayMs: 800 }, drop: { percent: 30 }, clear: {} };
document.querySelectorAll('[data-chaos]').forEach(b => b.addEventListener('click', () =>
  needNode() && call('farzad', 'POST', '/chaos', { action: b.dataset.chaos, nodeId: selected, ...CHAOS[b.dataset.chaos] })));
$('#gwKill').addEventListener('click', () => call('pisak', 'POST', '/admin', { action: 'kill' }));
$('#gwRevive').addEventListener('click', () => call('pisak', 'POST', '/admin', { action: 'revive' }));

pollState();
setInterval(pollState, 1000);
setInterval(pollEvents, 500);
