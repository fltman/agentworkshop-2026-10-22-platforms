'use strict';
(function () {
  const API = '/t/farzad/api';
  const INFLIGHT_LIMIT = 50;
  const POLL_MS = 1000;
  const STATES = ['reachable', 'initializing', 'restarting', 'unreachable', 'disabled'];
  const OOS_MARK = '\u00b1';
  // Short marks for the gateway's raw peer status in a via-gateway cell.
  const PEER_MARK = { up: '', slow: 's', down: 'd', restarting: 'r', leaving: 'l' };

  let state = null;
  let selected = null;
  let timer = null;
  let polling = false;

  const $ = (id) => document.getElementById(id);

  function el(tag, opts, ...children) {
    const e = document.createElement(tag);
    if (opts) {
      if (opts.cls) e.className = opts.cls;
      if (opts.text != null) e.textContent = String(opts.text);
      if (opts.title) e.title = opts.title;
      if (opts.type) e.type = opts.type;
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  async function getState() {
    const r = await fetch(`${API}/state`);
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, ok: r.ok, json };
  }

  function fmtMs(v) { return v == null ? '-' : `${v} ms`; }
  function fmtAge(ms) { return ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`; }
  const obj = (v) => (v && typeof v === 'object' ? v : {});

  // Failure codes as red chips, highest count first.
  function failureChips(failures) {
    const entries = Object.entries(obj(failures)).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return [el('span', { cls: 'hint', text: 'none' })];
    return entries.map(([k, v]) => el('span', { cls: 'chip', text: `${k} ${v}` }));
  }

  function miniTable(head, rows) {
    const t = el('table', { cls: 'mini' }, el('thead', null, el('tr', null, ...head.map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    for (const r of rows) tb.append(el('tr', null, ...r.map((c) => (c instanceof Node ? el('td', null, c) : el('td', { text: c == null ? '-' : c })))));
    t.append(tb);
    return t;
  }

  function ageText(ts) {
    if (ts == null) return 'never';
    const s = (Date.now() - ts) / 1000;
    return s < 0 ? 'just now' : `${s.toFixed(1)} s ago`;
  }

  // ---- header ----
  function renderSummary(s) {
    const m = s.metrics || {};
    const mesh = m.mesh || {};
    const gw = m.gateway || {};
    const item = (label, value, cls, title) => {
      const span = el('span', { title }, `${label} `);
      span.append(el('b', { text: value, cls }));
      return span;
    };
    $('summary').replaceChildren(
      item('mode', s.switching ? `${s.mode} (switching)` : s.mode, `mode-${s.mode}`),
      item('links open', `${s.openConnections ?? '-'}/${s.possibleLinks ?? '-'}`, null, 'openConnections / possibleLinks'),
      item('detect mesh', fmtMs(mesh.detectMs), null, `latest; average ${fmtMs(mesh.detectMsAvg)}`),
      item('detect gateway', fmtMs(gw.detectMs), null, `latest; average ${fmtMs(gw.detectMsAvg)}`),
      item('nodes', String((s.nodes || []).length))
    );
  }

  // ---- cluster internals (summary) ----
  function renderInternals(s) {
    const box = $('internals');
    const sum = s.summary;
    if (!sum || typeof sum !== 'object') {
      box.replaceChildren(el('span', { cls: 'hint', text: 'this backend does not report internals yet' }));
      return;
    }
    const item = (label, ...value) => el('span', null, `${label} `, ...value);
    const byState = obj(sum.linksByState);
    const states = STATES.filter((st) => byState[st]).concat(Object.keys(byState).filter((st) => !STATES.includes(st)));
    const links = states.length
      ? states.map((st) => el('span', { title: st }, el('span', { cls: `sw s-${STATES.includes(st) ? st : 'unknown'}` }), el('b', { text: byState[st] }), ' '))
      : [el('span', { cls: 'hint', text: 'none' })];
    const cs = obj(sum.clockSync);
    const pv = obj(sum.peerViews);
    const pvStates = Object.keys(pv).filter((st) => pv[st]);
    box.replaceChildren(
      item('links', ...links),
      item('clock sync', el('b', { text: `${cs.in ?? 0} in / ${cs.out ?? 0} out` }), `, max |offset| ${fmtMs(sum.maxAbsOffsetMs)}`),
      item('messaging disabled', el('b', { text: sum.messagingDisabled ?? '-', cls: sum.messagingDisabled ? 'warn' : null })),
      item('inflight', el('b', { text: sum.inflight ?? '-' })),
      item('pending', el('b', { text: sum.pending ?? '-', title: 'requests sent, awaiting response' })),
      item('queued', el('b', { text: sum.queued ?? '-', title: 'sends waiting for messaging to open' })),
      item('failures', ...failureChips(sum.failures)));
    if (s.mode === 'gateway' && pvStates.length) {
      const views = (s.links || []).filter((l) => l.via === 'gateway');
      const slow = views.filter((l) => l.peerStatus === 'slow').length;
      const unknown = pv.unknown || 0;
      const total = pvStates.reduce((a, st) => a + pv[st], 0);
      const counts = pvStates.filter((st) => st !== 'unknown').map((st) => el('span', { title: st },
        el('span', { cls: `sw via ${STATES.includes(st) ? `s-${st}` : 's-unknown'}` }), el('b', { text: pv[st] }), ' '));
      const extra = [];
      if (slow) extra.push(el('span', { title: 'reachable, but the gateway reports it slow' }, el('span', { cls: 'sw via s-reachable slow' }), el('b', { text: slow, cls: 'warn' }), ' slow '));
      if (unknown) {
        extra.push(el('span', { title: 'no peers info from the gateway for these views' }, el('span', { cls: 'sw via s-noview' }), el('b', { text: unknown }), ' unknown'));
        if (unknown === total) extra.push(el('span', { cls: 'hint', text: ' (gateway sends no peers)' }));
      }
      box.append(item('peer views via gateway', ...counts, ...extra));
    }
  }

  // ---- mesh vs gateway, whole last run of each mode ----
  function renderLastRun(s) {
    const box = $('lastRun');
    const lr = obj(obj(s.metrics).lastRun);
    const modes = ['mesh', 'gateway'].filter((m) => lr[m] && typeof lr[m] === 'object');
    if (!modes.length) { box.replaceChildren(); return; }
    const runs = modes.map((m) => lr[m]);
    const fmtPct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)} %` : '-');
    const rows = [
      ['run', (r) => (r.endedTs == null ? 'live' : `ended ${ageText(r.endedTs)}`)],
      ['duration', (r) => fmtAge(r.durationMs)],
      ['nodes', (r) => r.nodes],
      ['links open', (r) => `${r.openConnections ?? '-'}/${r.possibleLinks ?? '-'}`],
      ['messages', (r) => r.messages],
      ['p50 / p95', (r) => `${fmtMs(r.p50Ms)} / ${fmtMs(r.p95Ms)}`],
      ['throughput', (r) => (r.throughputPerSec == null ? '-' : `${r.throughputPerSec}/s`)],
      ['error rate', (r) => fmtPct(r.errorRate)],
      ['detect avg', (r) => fmtMs(r.detectMsAvg)],
      ['failures', (r) => el('span', null, ...failureChips(r.failures))],
    ];
    box.replaceChildren(
      el('div', { cls: 'hint', text: 'mesh vs gateway, whole last run of each mode' }),
      miniTable([''].concat(modes), rows.map(([label, f]) => [label].concat(runs.map(f)))));
  }

  // ---- link matrix ----
  function matrixColumns(s) {
    const nodes = s.nodes || [];
    const links = s.links || [];
    const hasGw = links.some((l) => l.to === 'gateway');
    const views = links.some((l) => l.via === 'gateway');
    if (s.mode === 'gateway' && !views) return ['gateway'];
    const cols = nodes.filter((n) => views || !n.external).map((n) => n.nodeId);
    for (const l of links) if (l.to !== 'gateway' && !cols.includes(l.to)) cols.push(l.to);
    if (hasGw) cols.push('gateway');
    return cols;
  }

  // Link-state class; a via-gateway view the gateway has not told us about gets its own grey.
  function stateCls(l) {
    if (l.state === 'unknown' && l.via === 'gateway') return 's-noview via';
    const cls = STATES.includes(l.state) ? `s-${l.state}` : 's-unknown';
    return l.via === 'gateway' ? `${cls} via${l.peerStatus === 'slow' ? ' slow' : ''}` : cls;
  }

  function linkTitle(l) {
    const parts = [`${l.from} \u2192 ${l.to}${l.via === 'gateway' ? ' (via gateway)' : ''}: ${l.state}${l.peerStatus ? ` (gateway says ${l.peerStatus})` : ''}`];
    if (l.clockSync != null) parts.push(`clock ${l.clockSync} sync, offset ${l.offsetMs ?? '-'} ms`);
    parts.push(`${l.via === 'gateway' ? 'last probe naming this peer' : 'last heartbeat'} ${ageText(l.lastHeartbeatTs)}`);
    return parts.join('\n');
  }

  function renderMatrix(s) {
    const nodes = s.nodes || [];
    const byPair = new Map();
    for (const l of s.links || []) byPair.set(`${l.from}\u0000${l.to}`, l);
    const cols = matrixColumns(s);

    const headRow = el('tr', null, el('th', { text: 'from \\ to', cls: 'corner' }));
    for (const c of cols) headRow.append(el('th', { text: c === 'gateway' ? 'gw' : c, title: c }));
    const thead = el('thead', null, headRow);

    const tbody = el('tbody');
    for (const n of nodes) {
      const btn = el('button', { type: 'button', text: n.nodeId, title: `${n.nodeId}: ${n.status}, messaging ${n.messaging}` });
      btn.addEventListener('click', () => { selected = n.nodeId; render(); });
      const th = el('th', { cls: `row st-${n.status}${selected === n.nodeId ? ' sel' : ''}` }, btn);
      if (n.external) th.append(el('span', { cls: 'ext', text: 'ext', title: 'external node' }));
      const tr = el('tr', null, th);
      for (const c of cols) {
        const td = el('td');
        if (c === 'gateway') td.className = 'gw';
        const l = byPair.get(`${n.nodeId}\u0000${c}`);
        if (c === n.nodeId) {
          td.classList.add('s-self');
        } else if (!l) {
          td.classList.add('s-none');
          td.title = `${n.nodeId} \u2192 ${c}: no link`;
        } else {
          td.className = `${td.className} ${stateCls(l)}`.trim();
          td.title = linkTitle(l);
          if (l.via === 'gateway') {
            td.textContent = l.peerStatus == null ? (l.state === 'unknown' ? '?' : '') : (PEER_MARK[l.peerStatus] ?? '*');
          } else if (l.clockSync === 'out') {
            td.classList.add('oos');
            td.textContent = OOS_MARK;
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    $('matrix').replaceChildren(thead, tbody);
  }

  function renderLegend(s) {
    const items = STATES.map((st) => el('span', null, el('span', { cls: `sw s-${st}` }), st));
    const oos = el('span', { cls: 'sw s-reachable oos', text: OOS_MARK });
    items.push(el('span', { title: '|offsetMs| > 100' }, oos, 'clock out of sync'));
    items.push(el('span', null, el('span', { cls: 'sw s-none' }), 'no link'));
    if (s && s.mode === 'gateway') {
      items.push(el('span', { title: 'what the gateway probes say about the peer; mark = raw status (s slow, d down, r restarting, l leaving)' }, el('span', { cls: 'sw s-reachable via' }), 'via gateway'));
      items.push(el('span', { title: 'gateway status slow, counted as reachable' }, el('span', { cls: 'sw s-reachable via slow', text: 's' }), 'slow'));
      items.push(el('span', { title: 'no peers info from the gateway' }, el('span', { cls: 'sw s-noview via', text: '?' }), 'unknown'));
    }
    $('legend').replaceChildren(...items);
  }

  // ---- node panel ----
  function renderNode() {
    const panel = $('nodePanel');
    const n = state && (state.nodes || []).find((x) => x.nodeId === selected);
    if (!n) {
      $('nodeTitle').textContent = selected ? `${selected} is gone` : 'pick a row in the matrix';
      panel.replaceChildren();
      return;
    }
    $('nodeTitle').textContent = `${n.nodeId}${n.external ? ' (external)' : ''}`;
    const statusCls = n.status === 'up' ? 'ok' : n.status === 'down' ? 'bad' : 'warn';
    const limit = (n.limits && n.limits.inflight) || INFLIGHT_LIMIT;
    const pct = Math.min(100, Math.round(((n.inflight || 0) / limit) * 100));
    const bar = el('span', { cls: `bar${pct >= 80 ? ' hot' : ''}` }, el('i'));
    bar.firstChild.style.width = `${pct}%`;
    const ch = n.chaos || {};
    const kv = el('dl', { cls: 'kv' },
      el('dt', { text: 'status' }), el('dd', { text: n.status, cls: statusCls }),
      el('dt', { text: 'messaging' }), el('dd', { text: n.messaging, cls: n.messaging === 'enabled' ? 'ok' : 'warn' }),
      el('dt', { text: 'inflight' }), el('dd', null, bar, `${n.inflight ?? 0} / ${limit}`),
      el('dt', { text: 'chaos' }), el('dd', { text: `delay ${ch.delayMs ?? 0} ms, drop ${ch.dropPercent ?? 0}%, skew ${ch.skewMs ?? 0} ms` }));
    if (n.queued != null) kv.append(el('dt', { text: 'queued' }), el('dd', { text: n.queued, title: 'sends waiting for messaging to open' }));
    if (n.pending != null) kv.append(el('dt', { text: 'pending' }), el('dd', { text: n.pending, title: 'requests sent, awaiting response' }));
    if (n.dedup) kv.append(el('dt', { text: 'dedup' }), el('dd', { text: `${n.dedup.size ?? '-'} cached, ${n.dedup.hits ?? '-'} duplicates caught` }));
    if (n.gateway && (state.mode === 'gateway' || n.external)) {
      const g = n.gateway;
      const probe = g.lastProbeAgeMs == null ? '' : `, last probe ${fmtAge(g.lastProbeAgeMs)} ago`;
      kv.append(el('dt', { text: 'gateway' }), el('dd', { text: `${g.registered ? 'registered' : 'not registered'}${probe}`, cls: g.registered ? 'ok' : null }));
    }
    const parts = [kv];

    if (n.counters) {
      const c = n.counters;
      const sent = obj(c.sent);
      const rec = obj(c.received);
      const types = ['request', 'response', 'oneway', 'broadcast'];
      parts.push(el('h3', { text: 'messages' }),
        miniTable(['', ...types], [['sent', ...types.map((t) => sent[t] ?? 0)], ['received', ...types.map((t) => rec[t] ?? 0)]]),
        el('h3', { text: 'failures (as sender)' }), el('div', null, ...failureChips(c.failures)));
    }

    const own = (state.links || []).filter((l) => l.from === n.nodeId);
    const byPeer = n.counters ? obj(n.counters.byPeer) : {};
    const peerIds = [...new Set(Object.keys(byPeer).concat(own.filter((l) => l.to !== 'gateway').map((l) => l.to)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (n.counters && n.counters.byPeer && peerIds.length) {
      const q = (c) => { const x = obj(c); return `${x.request ?? 0}/${x.response ?? 0}/${x.oneway ?? 0}/${x.broadcast ?? 0}`; };
      const gwMode = state.mode === 'gateway';
      const rows = peerIds.map((id) => {
        const p = byPeer[id] || {};
        const l = own.find((x) => x.to === id);
        const raw = l && l.via === 'gateway' && l.peerStatus ? ` (${l.peerStatus})` : '';
        const st = l ? el('span', { title: l.via ? `via ${l.via}` : '', cls: l.peerStatus === 'slow' ? 'warn' : null }, el('i', { cls: stateCls(l) }), `${l.state}${raw}`) : '-';
        const f = Object.entries(obj(p.failures)).map(([k, v]) => `${k} ${v}`).join(', ');
        const row = [id, st];
        if (gwMode) row.push(l && l.via === 'gateway' ? fmtAge(l.heartbeatAgeMs) : '-');
        return row.concat([q(p.sent), q(p.received), f || '-']);
      });
      const head = gwMode ? ['peer', 'link', 'probe age', 'sent', 'received', 'failures'] : ['peer', 'link', 'sent', 'received', 'failures'];
      parts.push(el('h3', { text: 'per peer (req/resp/oneway/bcast)' }), miniTable(head, rows));
    }
    if (own.length && own.some((l) => 'misses' in l)) {
      const rows = own.map((l) => {
        const st = el('span', null, el('i', { cls: stateCls(l) }), l.state);
        const off = l.offsetMs == null ? '-' : `${l.offsetMs}${l.clockSync === 'out' ? ` ${OOS_MARK}` : ''}`;
        return [l.via === 'gateway' ? `${l.to} (gw)` : l.to, st, l.misses, off, fmtAge(l.heartbeatAgeMs)];
      });
      parts.push(el('h3', { text: 'links from this node' }), miniTable(['peer', 'state', 'misses', 'offset ms', 'heartbeat age'], rows));
    }

    const apps = el('ul', { cls: 'apps' });
    for (const a of n.apps || []) {
      const li = el('li', null, el('b', { text: a.appId }));
      const types = Object.entries(a.msgTypes || {}).map(([k, v]) => `${k}=${v}`);
      if (types.length) li.append(` types ${types.join(', ')}`);
      for (const lid of a.listenerIds || []) li.append(el('div', { cls: 'lid', text: `listener ${lid}` }));
      apps.append(li);
    }
    if (!(n.apps || []).length) apps.append(el('li', { cls: 'hint', text: 'no apps' }));

    panel.replaceChildren(...parts, el('h3', { text: 'apps and listeners' }), apps);
  }

  // ---- polling ----
  function render() {
    if (!state) return;
    renderSummary(state);
    renderMatrix(state);
    renderLegend(state);
    renderInternals(state);
    renderLastRun(state);
    renderNode();
  }

  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const r = await getState();
      if (!r.ok || !r.json) throw new Error(r.json && r.json.error ? r.json.error.code : `HTTP ${r.status}`);
      state = r.json;
      $('stateErr').textContent = '';
      render();
    } catch (e) {
      $('stateErr').textContent = `state: ${e.message}`;
    } finally {
      polling = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (document.hidden) return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = null; } else { refresh().then(schedule); }
  });

  refresh().then(schedule);
})();
