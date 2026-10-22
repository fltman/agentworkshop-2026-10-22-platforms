// The menu at the top of every page on The Square. No dependencies.
//
// A page includes it with two lines, and does not style the menu itself:
//   <nav id="nav"></nav>                         (first thing in <body>)
//   <script src="/nav.js" defer></script>
//
// It fills in Square · Colony · Teams · News · Radio · Workshop, marks the page you are on, shows the
// group's name from /api/health, and adds "All groups" when the group has a hub (health.hub_url).
// On the hub itself (health.hub) the chat is "Plenary Square" at /square, and "All groups" is /.
// /torget is the old name for /square and still works.
// It hides itself inside an iframe and with ?nav=0. Pages that need the height use var(--nav-h).
(function () {
  if (window.__squareNav) return;
  window.__squareNav = true;

  // The newsreel look of the intro film: a navy band with a gold rule, Jost for the items, Bowlby One SC for
  // the group's name. The fonts are this board's own files (see newsreel.css), with system fallbacks.
  var CSS = [
    "@font-face{font-family:'Bowlby One SC';font-weight:400;font-display:swap;src:url(/bowlby-one-sc.woff2) format('woff2')}",
    "@font-face{font-family:'Jost';font-weight:400 700;font-display:swap;src:url(/jost.woff2) format('woff2')}",
    ':root{--nav-h:48px}',
    'nav#nav.tg-nav{display:flex;align-items:center;gap:4px;box-sizing:border-box;width:100%;min-height:48px;margin:0;',
    'padding:0 10px;background:#253850;color:#fceed2;border:0;border-bottom:3px solid #dca844;position:sticky;top:0;',
    'z-index:2147483000;overflow-x:auto;overflow-y:hidden;white-space:nowrap;grid-column:1/-1;scrollbar-width:none;',
    "font:600 16px/1.2 Jost,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.02em;",
    'text-align:left;-webkit-font-smoothing:antialiased;box-shadow:0 2px 0 #121617}',
    'nav#nav.tg-nav::-webkit-scrollbar{display:none}',
    "nav#nav.tg-nav .tg-grupp{flex:none;color:#dca844;font:400 15px/1 'Bowlby One SC',Impact,'Arial Black',sans-serif;",
    'letter-spacing:.04em;text-transform:uppercase;padding:6px 14px 6px 4px;margin:0 6px 0 0;border-right:2px solid #3b5272}',
    'nav#nav.tg-nav a{flex:none;display:inline-block;color:#f6e1bd;background:transparent;text-decoration:none;',
    'border:2px solid transparent;border-radius:8px;padding:6px 12px;margin:0;font:inherit;line-height:1.2}',
    'nav#nav.tg-nav a:hover{color:#fceed2;background:#32496a}',
    'nav#nav.tg-nav a:focus-visible{outline:2px solid #dca844;outline-offset:1px}',
    'nav#nav.tg-nav a[aria-current="page"]{color:#121617;background:#dca844;border-color:#121617}',
    'nav#nav.tg-nav a.tg-hub{margin-left:auto;border-color:#5a7193;color:#fceed2}',
    'nav#nav.tg-nav a.tg-hub[aria-current="page"]{color:#121617;border-color:#121617}',
    '@media (max-width:560px){nav#nav.tg-nav{font-size:14px;padding:0 6px}nav#nav.tg-nav a{padding:6px 8px}',
    'nav#nav.tg-nav .tg-grupp{display:none}}'
  ].join('');

  function start() {
    var q = new URLSearchParams(location.search);
    var iRam = false;
    try { iRam = window.self !== window.top; } catch (e) { iRam = true; }
    var el = document.getElementById('nav');
    if (!el) {
      el = document.createElement('nav');
      el.id = 'nav';
      document.body.insertBefore(el, document.body.firstChild);
    }
    if (q.get('nav') === '0' || (iRam && q.get('nav') !== '1')) {
      el.style.display = 'none';
      document.documentElement.style.setProperty('--nav-h', '0px');
      return;
    }
    if (!document.getElementById('tg-nav-css')) {
      var s = document.createElement('style');
      s.id = 'tg-nav-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    el.className = (el.className ? el.className + ' ' : '') + 'tg-nav';
    el.setAttribute('aria-label', 'The Square');

    var halsa = null;
    try { halsa = JSON.parse(sessionStorage.getItem('tg-nav-health') || 'null'); } catch (e) {}
    rita(el, halsa || {});

    var styr = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (styr) styr.abort(); }, 5000);
    fetch('/api/health', { cache: 'no-store', signal: styr ? styr.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        clearTimeout(timer);
        if (!h || typeof h !== 'object') return;
        var spara = { grupp: h.grupp || '', grupp_namn: h.grupp_namn || '', hub: !!h.hub, hub_url: h.hub_url || '', summary: harSummary() };
        try { sessionStorage.setItem('tg-nav-health', JSON.stringify(spara)); } catch (e) {}
        rita(el, spara);
      })
      .catch(function () { clearTimeout(timer); });   // no health: the menu works without it
    fetch('/data/workshop-summary.html', { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return;
        var nu = null;
        try { nu = JSON.parse(sessionStorage.getItem('tg-nav-health') || 'null'); } catch (e) {}
        nu = nu || halsa || {};
        nu.summary = true;
        try { sessionStorage.setItem('tg-nav-health', JSON.stringify(nu)); } catch (e) {}
        rita(el, nu);
      })
      .catch(function () {});
  }

  // Whether the summary check (below) has found the page in this tab; it can answer before or after /api/health.
  function harSummary() {
    try { return !!(JSON.parse(sessionStorage.getItem('tg-nav-health') || 'null') || {}).summary; } catch (e) { return false; }
  }

  function rita(el, h) {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    var hub = !!h.hub;
    var punkter = [
      hub ? ['Plenary Square', '/square', /^\/(square|torget)$/] : ['Square', '/', /^\/(index\.html|square|torget)?$/],
      ['Colony', '/colony', /^\/(colony|staden)(\/|$)/],
      ['Teams', '/teams', /^\/(teams|lagen)(\.html)?$/],
      ['News', '/news', /^\/news(\.html)?$/],
      ['Radio', '/radio', /^\/radio(\.html)?$/],
      ['Workshop', '/workshop', /^\/workshop([./]|$)/]
    ];
    // The summary of the day, once the lead has put it among the shared files (verktyg/delad-data.sh).
    if (h.summary) punkter.push(['Summary', '/data/workshop-summary.html', /^\/data\/workshop-summary\.html$/]);
    if (hub) punkter.push(['All groups', '/', /^\/(hub(\.html)?)?$/, 'tg-hub']);
    else if (h.hub_url) punkter.push(['All groups', h.hub_url, null, 'tg-hub']);

    el.textContent = '';
    var namn = h.grupp_namn || '';
    if (namn) {
      var b = document.createElement('span');
      b.className = 'tg-grupp';
      b.textContent = namn;
      el.appendChild(b);
    }
    var markerad = false;
    punkter.forEach(function (x) {
      var a = document.createElement('a');
      a.textContent = x[0];
      a.href = x[1];
      if (x[3]) a.className = x[3];
      if (!markerad && x[2] && x[2].test(p)) { a.setAttribute('aria-current', 'page'); markerad = true; }
      el.appendChild(a);
    });
    var hojd = el.offsetHeight;
    if (hojd) document.documentElement.style.setProperty('--nav-h', hojd + 'px');
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
