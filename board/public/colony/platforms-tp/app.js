const els = {
  modeBadge: document.getElementById('modeBadge'),
  throughput: document.getElementById('throughput'),
  p50: document.getElementById('p50'),
  p95: document.getElementById('p95'),
  connections: document.getElementById('connections'),
  modeLabel: document.getElementById('modeLabel'),
  nodeCount: document.getElementById('nodeCount'),
  gatewayStatus: document.getElementById('gatewayStatus'),
  chaosStatus: document.getElementById('chaosStatus'),
  scenarioStep: document.getElementById('scenarioStep'),
  rate: document.getElementById('rate'),
  payload: document.getElementById('payload'),
  dropRate: document.getElementById('dropRate'),
  events: document.getElementById('events'),
};

async function loadState() {
  const res = await fetch('/t/platforms-tp/api/state');
  if (!res.ok) return;
  const state = await res.json();
  renderState(state);
}

function renderState(state) {
  els.modeBadge.textContent = state.mode;
  els.modeLabel.textContent = state.mode;
  els.throughput.textContent = state.metrics.throughput;
  els.p50.textContent = state.metrics.latencyP50;
  els.p95.textContent = state.metrics.latencyP95;
  els.connections.textContent = state.metrics.openConnections;
  els.nodeCount.textContent = state.nodeCount;
  els.gatewayStatus.textContent = state.gateway.healthy ? 'healthy' : 'down';
  els.chaosStatus.textContent = state.chaos.dropRate > 0 || state.chaos.nodeKilled !== null ? 'fault injected' : 'steady';
  els.scenarioStep.textContent = state.scenario.step;
  els.rate.value = state.traffic.rate;
  els.payload.value = state.traffic.payloadBytes;
  els.dropRate.value = state.chaos.dropRate;

  if (Array.isArray(state.events)) {
    els.events.innerHTML = '';
    for (const event of state.events.slice(-6).reverse()) {
      const li = document.createElement('li');
      const time = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.textContent = `${time} • ${event.text}`;
      els.events.appendChild(li);
    }
  }
}

async function sendAction(action, extra = {}) {
  const payload = { action, ...extra };
  const res = await fetch('/t/platforms-tp/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return;
  const data = await res.json();
  renderState(data.state);
}

for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'toggle-mode') return sendAction('toggle-mode');
    if (action === 'start-scenario') return sendAction('start-scenario', { name: 'live-demo' });
    if (action === 'toggle-gateway') return sendAction('toggle-gateway');
    if (action === 'toggle-ha') return sendAction('toggle-ha');
    if (action === 'reset') return sendAction('reset');
    if (action === 'kill-node') return sendAction('kill-node', { nodeId: Number(button.dataset.node || 2) });
    if (action === 'slow-node') return sendAction('slow-node', { nodeId: Number(button.dataset.node || 3), latencyMs: 3000 });
    if (action === 'drop-messages') return sendAction('drop-messages', { dropRate: Number(els.dropRate.value || 10) });
  });
}

els.rate.addEventListener('input', () => sendAction('set-traffic', {
  rate: Number(els.rate.value),
  payloadBytes: Number(els.payload.value),
  dropRate: Number(els.dropRate.value),
}));
els.payload.addEventListener('input', () => sendAction('set-traffic', {
  rate: Number(els.rate.value),
  payloadBytes: Number(els.payload.value),
  dropRate: Number(els.dropRate.value),
}));
els.dropRate.addEventListener('input', () => sendAction('set-traffic', {
  rate: Number(els.rate.value),
  payloadBytes: Number(els.payload.value),
  dropRate: Number(els.dropRate.value),
}));

loadState();
setInterval(loadState, 5000);
