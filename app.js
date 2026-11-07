/* Rummy Combos — the UI. Every screen is rendered from state; clicks are routed by data-act.
   Words on screen: a tournament (טורניר) has participants and games (משחקים). Nothing in between. */
(function () {
  'use strict';

  const R = window.Rummy;
  const ST = window.RummyStats;
  const T = window.RummyTournaments;
  const SY = window.RummySync;

  const KEY = 'rummycombos.v2';
  const OLD_KEY = 'rummycombos.v1';
  const GH_KEY = 'rummycombos.github';
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const UNDO_LIMIT = 50;
  const BACKUP_NAG = 30;

  let state = loadState();
  let gh = loadGh();
  let undoStack = []; // [{ id: tournament id, json: the tournament before the change }]
  let view = { name: 'home' };
  let stack = [];
  let overlays = [];
  let sheet = null;
  let sheetLayer = null;
  let flashPid = null;
  let lastRenderKey = '';

  const $view = document.getElementById('view');
  const $overlay = document.getElementById('overlay-root');

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const signed = (n) => (n > 0 ? '+' + n : String(n));
  const round1 = (x) => String(Math.round(x * 10) / 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const winsText = (n) => (n === 1 ? 'ניצחון אחד' : n + ' ניצחונות');
  const gamesText = (n) => (n === 1 ? 'משחק אחד' : n + ' משחקים');
  const playedText = (n) => (n === 1 ? 'שוחק משחק אחד' : 'שוחקו ' + n + ' משחקים');
  const toursText = (n) => (n === 1 ? 'טורניר אחד' : n + ' טורנירים');
  const andList = (list) => (list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' ו' + list[list.length - 1]);
  const tourById = (id) => T.find(state.tournaments, id);
  const activeTours = () => T.live(state.tournaments).filter((t) => !t.finishedAt);
  const byRecent = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
  const playerName = (t, id) => (R.playerById(t, id) || { name: '' }).name;
  const minus = (n) => `<span class="num">-${n}</span>`;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function curTour() {
    const t = tourById(view.id);
    return t && !t.deleted ? t : null;
  }

  function winnerNames(t) {
    return (t.winnerIds || []).map((id) => playerName(t, id)).filter(Boolean);
  }

  function finishedCount() {
    return T.live(state.tournaments).reduce((s, t) => s + R.finishedGames(t).length, 0);
  }

  function fmtDate(iso, long) {
    const opts = long
      ? { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' }
      : { day: 'numeric', month: 'numeric', year: '2-digit' };
    return new Date(iso).toLocaleDateString('he-IL', opts);
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg.replace(/[+-]?\d+/g, (m) => '\u2066' + m + '\u2069'); // +30 / -10 stay as written inside Hebrew
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- storage ----------
  // Data saved by the first version (evenings made of rounds) is converted once; the old copy is left as is.
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* empty or blocked storage */ }
    if (!s || !Array.isArray(s.tournaments)) {
      s = { v: 2, tournaments: [], lastTournamentId: null, lastPlayers: [], backupGames: 0, sync: SY.emptySync() };
      let old = null;
      try { old = JSON.parse(localStorage.getItem(OLD_KEY)); } catch (e) { /* nothing to convert */ }
      if (old && (Array.isArray(old.history) || old.current)) {
        s.tournaments = T.fromV1(old);
        s.lastPlayers = Array.isArray(old.lastPlayers) ? old.lastPlayers : [];
        s.lastTournamentId = old.current ? old.current.tournamentId : old.lastTournamentId || null;
        s.tournaments.forEach((t) => SY.markDirty(s, t.id));
        s.converted = s.tournaments.length;
      }
    }
    s.sync = Object.assign(SY.emptySync(), s.sync || {});
    s.tournaments.forEach(R.normalize);
    return s;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('השמירה במכשיר נכשלה'); }
  }

  function loadGh() {
    try {
      const g = JSON.parse(localStorage.getItem(GH_KEY));
      return g && g.owner && g.repo && g.token ? g : null;
    } catch (e) {
      return null;
    }
  }

  function saveGh(g) {
    gh = g;
    try {
      if (g) localStorage.setItem(GH_KEY, JSON.stringify(g));
      else localStorage.removeItem(GH_KEY);
    } catch (e) { /* storage blocked */ }
  }

  // ---------- tournament changes (undoable) ----------
  function changeTour(t, fn) {
    undoStack.push({ id: t.id, json: JSON.stringify(t) });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    const out = fn(t);
    R.touch(t);
    tourSaved(t);
    return out;
  }

  function tourSaved(t) {
    SY.markDirty(state, t.id);
    persist();
    scheduleSync();
    render();
  }

  function canUndo(t) {
    return !!t && undoStack.length > 0 && undoStack[undoStack.length - 1].id === t.id;
  }

  // What comes back gets fresh stamps, so it also wins over copies already saved in git.
  function undo() {
    const t = curTour();
    if (!canUndo(t)) return;
    const prev = JSON.parse(undoStack.pop().json);
    const stamp = R.now();
    prev.games.forEach((g) => {
      const now = R.findGame(t, g.id);
      if (!now || JSON.stringify(now) !== JSON.stringify(g)) g.updatedAt = stamp;
    });
    if (prev.metaAt !== t.metaAt || prev.name !== t.name || JSON.stringify(prev.players) !== JSON.stringify(t.players)) prev.metaAt = stamp;
    prev.updatedAt = stamp;
    state.tournaments[state.tournaments.indexOf(t)] = R.normalize(prev);
    tourSaved(prev);
    toast('הפעולה האחרונה בוטלה');
  }

  // ---------- navigation ----------
  function go(name, params) {
    if (view.name === name && !params) return;
    stack.push(view);
    view = Object.assign({ name }, params || {});
    history.pushState({ rummy: 1 }, '');
    render();
    window.scrollTo(0, 0);
  }

  function replace(name, params) {
    view = Object.assign({ name }, params || {});
    render();
    window.scrollTo(0, 0);
  }

  function goHome() {
    stack = [];
    replace('home');
  }

  function back() {
    if (stack.length) history.back();
    else goHome();
  }

  function openTour(id) {
    const t = tourById(id);
    if (!t || t.deleted) return;
    if (!undoStack.length || undoStack[undoStack.length - 1].id !== id) undoStack = [];
    state.lastTournamentId = id;
    persist();
    if (view.name === 'tournament') replace('tournament', { id });
    else go('tournament', { id });
  }

  // The phone's back button closes an open sheet or dialog before it leaves the screen.
  window.addEventListener('popstate', () => {
    if (overlays.length) {
      removeLayer(overlays[overlays.length - 1]);
      history.pushState({ rummy: 1 }, '');
      return;
    }
    view = stack.length ? stack.pop() : { name: 'home' };
    render();
  });

  // ---------- overlays ----------
  function addLayer(html, onClose) {
    const el = document.createElement('div');
    el.innerHTML = html;
    $overlay.appendChild(el);
    const layer = { el, onClose };
    overlays.push(layer);
    return layer;
  }

  function removeLayer(layer) {
    const i = overlays.indexOf(layer);
    if (i < 0) return;
    overlays.splice(i, 1);
    layer.el.remove();
    if (layer.onClose) layer.onClose();
  }

  // Resolves with the clicked button's value, or opts.cancel when dismissed.
  function ask(opts) {
    return new Promise((resolve) => {
      const cancel = 'cancel' in opts ? opts.cancel : false;
      const buttons = opts.buttons.map((b, i) => `<button class="btn ${b.kind || ''}" data-dlg="${i}">${esc(b.label)}</button>`).join('');
      const layer = addLayer(`
        <div class="backdrop dialog-backdrop" data-dlg="cancel"></div>
        <div class="dialog" role="alertdialog" aria-modal="true">
          <h2>${esc(opts.title)}</h2>
          ${opts.body ? `<p>${opts.body}</p>` : ''}
          <div class="row${opts.buttons.length > 2 ? ' col' : ''}">${buttons}</div>
        </div>`, () => resolve(cancel));
      layer.el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-dlg]');
        if (!t) return;
        const value = t.dataset.dlg === 'cancel' ? cancel : opts.buttons[+t.dataset.dlg].value;
        resolve(value);
        removeLayer(layer);
      });
    });
  }

  // A dialog with one text field. Resolves with the cleaned text, or null when dismissed.
  // opts.validate(text) returns an error message, or '' when the text is fine.
  function askText(opts) {
    return new Promise((resolve) => {
      const layer = addLayer(`
        <div class="backdrop dialog-backdrop" data-dlg="cancel"></div>
        <div class="dialog form" role="dialog" aria-modal="true">
          <h2>${esc(opts.title)}</h2>
          ${opts.body ? `<p class="muted">${opts.body}</p>` : ''}
          <input type="text" id="dlg-text" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}" maxlength="40" autocomplete="off" enterkeyhint="done"${opts.list ? ` list="${opts.list}"` : ''}>
          ${opts.extra || ''}
          <p class="error" id="dlg-error"></p>
          <div class="row">
            <button class="btn primary" data-dlg="ok">${esc(opts.okLabel || 'שמור')}</button>
            <button class="btn" data-dlg="cancel">ביטול</button>
          </div>
        </div>`, () => resolve(null));
      const input = layer.el.querySelector('#dlg-text');
      const submit = () => {
        const text = R.cleanName(input.value);
        const err = text ? (opts.validate ? opts.validate(text) : '') : 'כתוב שם';
        if (err) { layer.el.querySelector('#dlg-error').textContent = err; return; }
        resolve(text);
        removeLayer(layer);
      };
      layer.el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-dlg]');
        if (!t) return;
        if (t.dataset.dlg === 'ok') submit();
        else removeLayer(layer);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  // ---------- git sync ----------
  let syncTimer = null;
  let syncing = false;
  let syncAgain = false;

  function scheduleSync(delay) {
    renderSyncBadge();
    if (!gh) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay == null ? 1500 : delay);
  }

  // A merge with another phone's copy may change what is on screen; screens with text fields are left alone.
  function renderIfIdle() {
    if (['home', 'tournament', 'reports', 'settings'].includes(view.name)) render();
  }

  async function runSync() {
    if (!gh) return;
    if (syncing) { syncAgain = true; return; }
    if (!SY.pending(state)) { renderSyncBadge(); return; }
    syncing = true;
    renderSyncBadge();
    const before = T.live(state.tournaments).map(T.sig).join();
    try {
      await SY.flush(state, gh);
    } catch (e) {
      state.sync.lastError = e.message;
    }
    syncing = false;
    persist();
    if (T.live(state.tournaments).map(T.sig).join() !== before) renderIfIdle();
    renderSyncBadge();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }

  async function pullFromGit(quiet) {
    if (!gh || syncing) return;
    syncing = true;
    renderSyncBadge();
    try {
      const res = await SY.pull(state, gh);
      persist();
      if (res.added) toast('נטענו מגיט ' + toursText(res.added));
      else if (!quiet) toast(res.updated ? 'עודכנו מגיט ' + toursText(res.updated) : 'הסנכרון הסתיים');
    } catch (e) {
      state.sync.lastError = e.message;
      persist();
      if (!quiet) toast(e.message);
    }
    syncing = false;
    renderIfIdle();
    scheduleSync(0);
  }

  function syncStatusText() {
    const s = state.sync;
    const n = SY.pending(state);
    if (syncing) return 'שומר בגיט…';
    if (s.lastError && n) return `לא נשמר: ${s.lastError}. ממתינים לשמירה: ${toursText(n)}`;
    if (n) return 'ממתינים לשמירה: ' + toursText(n);
    return s.lastSyncAt ? 'הכול שמור בגיט · סנכרון אחרון ' + fmtTime(s.lastSyncAt) : 'הכול שמור בגיט';
  }

  function renderSyncBadge() {
    const b = document.getElementById('sync-badge');
    if (!gh) { b.hidden = true; return; }
    const n = SY.pending(state);
    b.hidden = false;
    b.classList.toggle('err', !!state.sync.lastError && n > 0 && !syncing);
    b.textContent = syncing ? 'גיט ⟳' : state.sync.lastError && n ? 'גיט ⚠' : n ? 'גיט · ' + n : 'גיט ✓';
    const status = document.getElementById('sync-status');
    if (status) status.textContent = syncStatusText();
  }

  window.addEventListener('online', () => scheduleSync(0));

  // ---------- rendering ----------
  const VIEWS = {};

  // Rows marked data-flip slide to their new place when the order changes (e.g. someone passes the leader).
  function capturePositions() {
    const key = view.name + ':' + (view.id || '');
    const same = key === lastRenderKey;
    lastRenderKey = key;
    if (!same) return null;
    const pos = {};
    $view.querySelectorAll('[data-flip]').forEach((el) => { pos[el.dataset.flip] = el.getBoundingClientRect().top; });
    return pos;
  }

  function playFlip(pos) {
    if (!pos || reduceMotion()) return;
    $view.querySelectorAll('[data-flip]').forEach((el) => {
      const was = pos[el.dataset.flip];
      if (was == null || !el.animate) return;
      const d = was - el.getBoundingClientRect().top;
      if (Math.abs(d) < 1) return;
      el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }

  function render() {
    const fn = VIEWS[view.name] || VIEWS.home;
    const pos = capturePositions();
    $view.innerHTML = fn();
    playFlip(pos);
    flashPid = null;
    document.getElementById('btn-back').hidden = view.name === 'home';
    renderSyncBadge();
  }

  function backupNag() {
    const unsaved = finishedCount() - (state.backupGames || 0);
    if (gh || unsaved < BACKUP_NAG) return '';
    return `
      <button class="card warn" data-act="go" data-to="settings">
        <b>${unsaved} משחקים לא מגובים</b>
        <div class="muted">הם שמורים רק בטלפון הזה. חבר את האפליקציה לגיט או ייצא קובץ גיבוי.</div>
      </button>`;
  }

  // A tournament on the home screen: its standings (live while it runs).
  function tourCard(t) {
    const rows = R.standings(t, !t.finishedAt);
    const played = R.finishedGames(t).length;
    const cur = R.currentGame(t);
    const side = t.finishedAt ? 'הסתיים ' + fmtDate(t.finishedAt) : cur ? 'משחק ' + R.gameNumber(t, cur) : '';
    const winners = winnerNames(t);
    return `
      <button class="card tour-card" data-act="open-tour" data-id="${t.id}">
        <div class="hist-top"><b class="tour-title">${esc(t.name)}</b><span>${side}</span></div>
        ${t.finishedAt && winners.length ? `<div class="hist-winner">🏆 ${esc(andList(winners))}</div>` : ''}
        <ol class="mini-rank">${rows.map((r) => `<li>${r.place}. ${esc(r.player.name)} <b class="num">${r.total}</b></li>`).join('')}</ol>
        <div class="muted tour-line">${played ? playedText(played) : 'עוד לא הסתיים משחק'} · ${t.players.length} משתתפים${cur && !t.finishedAt ? ' · מחלק: ' + esc(playerName(t, R.dealerOf(t, cur))) : ''}</div>
      </button>`;
  }

  VIEWS.home = () => {
    const act = activeTours().sort(byRecent);
    const done = T.live(state.tournaments).filter((t) => t.finishedAt).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    let h = '';
    if (act.length) h += `<h2>${act.length === 1 ? 'הטורניר הפעיל' : 'טורנירים פעילים'}</h2>` + act.map(tourCard).join('');
    h += `<button class="btn ${act.length ? 'block' : 'primary big'}" data-act="new-tour">+ טורניר חדש</button>`;
    if (!act.length && !done.length) {
      h += '<p class="empty">טורניר הוא קבוצת משתתפים שמשחקת כמה משחקים.<br>הניקוד נצבר מכל המשחקים, וכל משחק נגמר כשמישהו מנצח.</p>';
    }
    h += backupNag();
    h += `
      <div class="tiles">
        <button class="btn" data-act="go" data-to="reports"><span class="ic">📊</span>סיכומים</button>
        <button class="btn" data-act="go" data-to="settings"><span class="ic">☁️</span>גיט וגיבוי</button>
      </div>`;
    if (done.length) h += '<h2>טורנירים שהסתיימו</h2>' + done.map(tourCard).join('');
    return h;
  };

  // ---------- new tournament ----------
  VIEWS['new-tour'] = () => {
    const known = ST.playerNames(state.tournaments);
    const rows = view.names.map((n, i) => `
      <li>
        <input class="pname" data-i="${i}" value="${esc(n)}" placeholder="משתתף ${i + 1}" list="known-names" maxlength="20" autocomplete="off" enterkeyhint="next">
        <button class="deal-chip${view.firstDealer === i ? ' on' : ''}" data-act="pick-dealer" data-i="${i}" aria-pressed="${view.firstDealer === i}">מחלק</button>
        <button class="btn icon danger" data-act="remove-player" data-i="${i}" aria-label="הסר"${view.names.length <= MIN_PLAYERS ? ' disabled' : ''}>✕</button>
      </li>`).join('');
    return `
      <section class="card form">
        <label for="tour-name">שם הטורניר</label>
        <input type="text" id="tour-name" value="${esc(view.tourName)}" placeholder="${esc(namePlaceholder())}" maxlength="40" autocomplete="off" enterkeyhint="next">
        <p class="muted tour-line">בלי שם, הטורניר ייקרא לפי המשתתפים.</p>
      </section>
      <h2>משתתפים</h2>
      <ul class="player-list">${rows}</ul>
      <datalist id="known-names">${known.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${view.names.length < MAX_PLAYERS ? '<button class="btn block" data-act="add-player">+ הוסף משתתף</button>' : ''}
      <p class="muted" style="margin-top:12px">"מחלק" מסמן מי מחלק במשחק הראשון. בכל משחק הבא מחלק המשתתף הבא ברשימה.</p>
      <p class="muted">אין מספר משחקים קבוע: משחקים כמה שרוצים ומסיימים את הטורניר מתי שמחליטים. אפשר גם להשאיר אותו פתוח ולהמשיך בפעם הבאה.</p>
      <button class="btn primary big" data-act="start-tour">התחל טורניר</button>
      <p class="error" id="setup-error"></p>`;
  };

  function namePlaceholder() {
    return T.defaultName(view.names) || 'למשל: אצל סבתא';
  }

  function startSetup(list) {
    const ns = (list || []).slice(0, MAX_PLAYERS);
    while (ns.length < MIN_PLAYERS) ns.push('');
    go('new-tour', { names: ns, tourName: '', firstDealer: 0 });
  }

  function removePlayer(i) {
    if (view.names.length <= MIN_PLAYERS) return;
    view.names.splice(i, 1);
    if (view.firstDealer === i) view.firstDealer = 0;
    else if (view.firstDealer > i) view.firstDealer--;
    render();
  }

  function startTour() {
    const ns = view.names.map(R.cleanName);
    const name = R.cleanName(view.tourName) || T.defaultName(ns);
    let err = '';
    if (ns.some((n) => !n)) err = 'יש שורה בלי שם. מלא אותה או הסר אותה.';
    else {
      const dup = ns.find((n, i) => ns.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
      if (dup) err = `השם "${dup}" מופיע פעמיים`;
      else if (T.findByName(state.tournaments, name)) err = `כבר יש טורניר בשם "${name}". בחר שם אחר.`;
    }
    if (err) { document.getElementById('setup-error').textContent = err; return; }
    const t = R.newTournament(name, ns, view.firstDealer);
    state.tournaments.push(t);
    state.lastPlayers = ns;
    state.lastTournamentId = t.id;
    undoStack = [];
    SY.markDirty(state, t.id);
    persist();
    scheduleSync();
    stack = [{ name: 'home' }];
    replace('tournament', { id: t.id });
    toast('בהצלחה! הטורניר התחיל');
  }

  // ---------- tournament screen ----------
  // One row per participant, highest total first. The total includes the game being played,
  // so the order changes as points come in.
  // Tapping the name opens the participant's entries in this game for fixing.
  function boardRow(t, g, r, lead, dealerId) {
    const p = r.player;
    const gp = R.gamePoints(g, p.id);
    const ent = R.entriesOf(g, p.id);
    const cls = ['prow', lead ? 'lead' : '', p.id === flashPid ? 'flash' : ''].join(' ').trim();
    // second line: the dealer mark, then this game's entries (on a narrow phone the name keeps the first line)
    const sub = (p.id === dealerId ? '<span class="deal-mark">מחלק</span>' : '') +
      (ent.length ? `<span class="entries">${ent.map((n) => `<span${n < 0 ? ' class="neg"' : ''}>${signed(n)}</span>`).join('')}</span>` : '');
    const who = `
          <span class="nm"><b>${esc(p.name)}</b>${r.wins ? `<span class="wins" title="${winsText(r.wins)}">🏆<span class="num">${r.wins}</span></span>` : ''}</span>
          ${sub ? `<small class="sub">${sub}</small>` : ''}`;
    return `
      <div class="${cls}" data-flip="${p.id}">
        <span class="place">${r.place}</span>
        ${ent.length ? `<button class="who" data-act="entries" data-pid="${p.id}" aria-label="הרישומים של ${esc(p.name)} במשחק">${who}</button>` : `<span class="who">${who}</span>`}
        <span class="gp num${gp ? '' : ' zero'}">${gp}</span>
        <span class="tot num">${r.total}</span>
        <span class="pm">
          <button class="btn plus primary" data-act="add" data-pid="${p.id}" aria-label="להוסיף נקודות ל${esc(p.name)}">+</button>
          <button class="btn minus" data-act="take" data-pid="${p.id}" aria-label="להוריד נקודות מ${esc(p.name)}">−</button>
        </span>
      </div>`;
  }

  function isLead(rows, r) {
    return rows.length > 1 && r.place === 1 && rows.some((x) => x.total !== r.total);
  }

  VIEWS.tournament = () => {
    const t = curTour();
    if (!t) { view = { name: 'home' }; return VIEWS.home(); }
    if (t.finishedAt) return finishedTourHtml(t);
    const g = R.currentGame(t);
    const n = R.gameNumber(t, g);
    const played = R.finishedGames(t).length;
    const rows = R.standings(t, true);
    const dealerId = R.dealerOf(t, g);
    const last = lastEntry(g);
    return `
      <section class="status">
        <div class="status-top">
          <b class="tour-head">${esc(t.name)}</b>
          <span class="muted">${played ? playedText(played) : 'המשחק הראשון'}</span>
        </div>
        <div class="game-line">
          <span class="game-no">משחק ${n}</span>
          ${dealerId ? `<button class="dealer-btn" data-act="change-dealer" aria-label="שינוי המחלק">מחלק: <b>${esc(playerName(t, dealerId))}</b><span class="edit-ic" aria-hidden="true">✎</span></button>` : ''}
        </div>
      </section>
      <div class="board">
        <div class="board-head"><span>#</span><span>משתתף</span><span>במשחק</span><span>כללי</span><span></span></div>
        ${rows.map((r) => boardRow(t, g, r, isLead(rows, r), dealerId)).join('')}
      </div>
      ${last ? `
      <div class="last-entry">
        <span class="le-text">הרישום האחרון: <b>${esc(playerName(t, last.pid))}</b> <span class="num${last.n < 0 ? ' neg' : ''}">${signed(last.n)}</span></span>
        <span class="le-btns">
          <button class="btn sm" data-act="fix-last">תיקון</button>
          <button class="btn sm danger" data-act="delete-last">מחיקה</button>
        </span>
      </div>
      <p class="hint">לתיקון רישום קודם: לחיצה על שם המשתתף.</p>` : ''}
      <button class="btn primary big" data-act="open-finish">סיום משחק ${n}</button>
      <div class="row"><button class="btn" data-act="undo"${canUndo(t) ? '' : ' disabled'}>↶ בטל פעולה</button></div>
      ${gamesTableHtml(t)}
      <section class="card manage">
        <h3>ניהול הטורניר</h3>
        <div class="tour-actions">
          <button class="btn sm" data-act="tour-add-player">+ משתתף</button>
          <button class="btn sm" data-act="tour-rename">שינוי שם</button>
          <button class="btn sm" data-act="tour-finish">סיום הטורניר</button>
          <button class="btn sm danger" data-act="tour-delete">מחיקה</button>
        </div>
      </section>`;
  };

  function finishedTourHtml(t) {
    const sum = ST.tournamentSummary(t);
    const winners = winnerNames(t);
    let h = `
      <section class="card">
        <div class="label">${esc(t.name)} · הסתיים ${fmtDate(t.finishedAt, true)}</div>
        <div class="winner-name">🏆 ${esc(andList(winners)) || '—'}</div>
        <div class="muted">${gamesText(sum.games)}</div>
      </section>
      <div class="board final">
        <div class="board-head"><span>#</span><span>משתתף</span><span>ניצחונות</span><span>נקודות</span></div>
        ${sum.players.map((s) => `
          <div class="prow${winners.includes(s.name) ? ' lead' : ''}">
            <span class="place">${s.place}</span>
            <span class="who"><span class="nm"><b>${esc(s.name)}</b></span></span>
            <span class="gp num">${s.wins}</span>
            <span class="tot num">${s.points}</span>
          </div>`).join('')}
      </div>
      <button class="btn primary big" data-act="rematch">טורניר חדש עם אותם משתתפים</button>
      ${gamesTableHtml(t)}
      <section class="card manage">
        <h3>ניהול הטורניר</h3>
        <div class="tour-actions">
          <button class="btn sm" data-act="tour-reopen">המשך את הטורניר</button>
          <button class="btn sm" data-act="tour-rename">שינוי שם</button>
          <button class="btn sm danger" data-act="tour-delete">מחיקה</button>
        </div>
      </section>`;
    return h;
  }

  // Finished games, newest first: what each participant got in each game. A row opens the game for fixing.
  function gamesTableHtml(t) {
    const rows = R.gameTable(t).reverse();
    if (!rows.length) return '';
    let h = `<h2 class="sec">משחקים <span class="muted">(${rows.length})</span></h2>
      <div class="table-wrap"><table class="score"><thead><tr><th class="c-no">#</th>`;
    t.players.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    rows.forEach((row) => {
      const res = row.game.result;
      h += `<tr data-act="edit-game" data-gid="${row.game.id}"><td class="c-no">${row.number}</td>`;
      t.players.forEach((p) => {
        if (!R.inGame(row.game, p.id)) { h += '<td class="muted">—</td>'; return; }
        const nd = !!(res.hands[p.id] && res.hands[p.id].notDown);
        const cls = [p.id === res.winnerId ? 'win' : '', nd ? 'nd' : ''].join(' ').trim();
        h += `<td${cls ? ` class="${cls}"` : ''}><span class="tot num">${signed(row.scores[p.id])}</span>${nd ? '<span class="delta">✕</span>' : ''}</td>`;
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h + `<div class="legend"><span>מסגרת = ניצח במשחק</span><span>✕ = לא ירד (${minus(R.NOT_DOWN_POINTS)})</span><span>לחיצה על משחק = תיקון</span></div>`;
  }

  // ---------- number pad ----------
  // opts: { title, value, okLabel, okKind, validate(n) → error or '', onSave(n), onDelete() (shows a delete button) }
  let pad = null;

  function openPad(opts) {
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="key" data-act="pad-key" data-k="${d}">${d}</button>`).join('');
    const layer = addLayer(`
      <div class="backdrop pad-backdrop" data-act="pad-cancel"></div>
      <div class="sheet pad" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
        <h2>${esc(opts.title)}</h2>
        <div class="pad-display num" id="pad-display"></div>
        <p class="error" id="pad-error"></p>
        <div class="keys">
          ${keys}
          <button class="key" data-act="pad-key" data-k="back" aria-label="מחק ספרה">⌫</button>
          <button class="key" data-act="pad-key" data-k="0">0</button>
          <button class="key ok${opts.okKind === 'danger' ? ' danger' : ''}" data-act="pad-ok">${esc(opts.okLabel || 'הוסף')}</button>
        </div>
        <div class="row">
          ${opts.onDelete ? '<button class="btn danger" data-act="pad-delete">מחק את הרישום</button>' : ''}
          <button class="btn" data-act="pad-cancel">ביטול</button>
        </div>
      </div>`, () => { pad = null; });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    pad = { opts, layer, value: opts.value ? String(opts.value) : '' };
    renderPad();
  }

  function renderPad() {
    const el = document.getElementById('pad-display');
    el.textContent = pad.value || '0';
    el.classList.toggle('empty', !pad.value);
  }

  function padKey(k) {
    if (!pad) return;
    if (k === 'back') pad.value = pad.value.slice(0, -1);
    else if (pad.value.length < String(R.MAX_POINTS).length) pad.value = (pad.value + k).replace(/^0+/, '');
    document.getElementById('pad-error').textContent = '';
    renderPad();
  }

  function padOk() {
    if (!pad) return;
    const n = Number(pad.value);
    const err = !R.validPoints(n) ? 'הזן מספר גדול מאפס' : pad.opts.validate ? pad.opts.validate(n) : '';
    if (err) { document.getElementById('pad-error').textContent = err; return; }
    const { opts, layer } = pad;
    removeLayer(layer);
    opts.onSave(n);
  }

  function padDelete() {
    if (!pad || !pad.opts.onDelete) return;
    const { opts, layer } = pad;
    removeLayer(layer);
    opts.onDelete();
  }

  function padCancel() {
    if (pad) removeLayer(pad.layer);
  }

  // ---------- points during the game ----------
  function addFor(pid) {
    const t = curTour();
    if (!t) return;
    const name = playerName(t, pid);
    openPad({
      title: `${name} · כמה נקודות להוסיף?`,
      okLabel: 'הוסף',
      onSave: (n) => {
        const tt = curTour();
        if (!tt) return;
        flashPid = pid;
        changeTour(tt, (tour) => {
          const g = R.currentGame(tour);
          R.addPoints(g, pid, n);
          R.touch(tour, g);
        });
        toast(`${name}: ${signed(n)}`);
      }
    });
  }

  // Takes points off a participant in the game being played: any amount (a mistake, or a penalty).
  function takeFrom(pid) {
    const t = curTour();
    if (!t) return;
    const name = playerName(t, pid);
    openPad({
      title: `${name} · כמה נקודות להוריד?`,
      okLabel: 'הורד',
      okKind: 'danger',
      onSave: (n) => {
        const tt = curTour();
        if (!tt) return;
        flashPid = pid;
        changeTour(tt, (tour) => {
          const g = R.currentGame(tour);
          R.takePoints(g, pid, n);
          R.touch(tour, g);
        });
        toast(`${name}: -${n}`);
      }
    });
  }

  // ---------- fixing what was entered in the game being played ----------
  // The last entry in a game: { pid, k (which of that participant's entries), n }, or null.
  function lastEntry(g) {
    const e = g.points[g.points.length - 1];
    return e ? { pid: e.pid, k: R.entriesOf(g, e.pid).length - 1, n: e.n } : null;
  }

  // Opens one entry in the number pad: save a new amount (the sign stays) or delete it.
  function editEntry(pid, k) {
    const t = curTour();
    const g = t && R.currentGame(t);
    const n = g ? R.entriesOf(g, pid)[k] : null;
    if (n == null) return;
    const name = playerName(t, pid);
    openPad({
      title: `${name} · תיקון הרישום ${signed(n)}`,
      value: Math.abs(n),
      okLabel: 'שמור',
      okKind: n < 0 ? 'danger' : '',
      onSave: (v) => {
        const tt = curTour();
        if (!tt) return;
        flashPid = pid;
        changeTour(tt, (tour) => {
          const gg = R.currentGame(tour);
          R.setEntry(gg, pid, k, v);
          R.touch(tour, gg);
        });
        toast(`${name}: ${signed(n < 0 ? -v : v)} במקום ${signed(n)}`);
        renderEntries();
      },
      onDelete: () => deleteEntry(pid, k)
    });
  }

  function deleteEntry(pid, k) {
    const t = curTour();
    const g = t && R.currentGame(t);
    const n = g ? R.entriesOf(g, pid)[k] : null;
    if (n == null) return;
    flashPid = pid;
    changeTour(t, (tour) => {
      const gg = R.currentGame(tour);
      R.removeEntry(gg, pid, k);
      R.touch(tour, gg);
    });
    toast(`${playerName(t, pid)}: הרישום ${signed(n)} נמחק`);
    renderEntries();
  }

  function fixLast(del) {
    const t = curTour();
    const last = t && lastEntry(R.currentGame(t));
    if (!last) return;
    if (del) deleteEntry(last.pid, last.k);
    else editEntry(last.pid, last.k);
  }

  // One participant's entries in the game being played; tapping one opens it for fixing.
  let entries = null; // { pid, layer }

  function openEntries(pid) {
    const layer = addLayer('<div class="backdrop" data-act="close-entries"></div><div class="sheet" role="dialog" aria-modal="true" id="entries-sheet"></div>', () => { entries = null; });
    entries = { pid, layer };
    renderEntries();
  }

  function closeEntries() {
    if (entries) removeLayer(entries.layer);
  }

  function renderEntries() {
    if (!entries) return;
    const t = curTour();
    const g = t && R.currentGame(t);
    const ent = g ? R.entriesOf(g, entries.pid) : [];
    if (!ent.length) { closeEntries(); return; }
    document.getElementById('entries-sheet').innerHTML = `
      <h2>${esc(playerName(t, entries.pid))} · משחק ${R.gameNumber(t, g)}</h2>
      <p class="muted">לחיצה על רישום פותחת אותו לתיקון או למחיקה.</p>
      <div class="pc-adds entry-list">${ent.map((n, k) => `<button class="add-chip num${n < 0 ? ' neg' : ''}" data-act="entry-edit" data-pid="${entries.pid}" data-k="${k}" aria-label="תיקון ${signed(n)}">${signed(n)}</button>`).join('')}</div>
      <p class="entry-sum">במשחק: <b class="num">${R.gamePoints(g, entries.pid)}</b></p>
      <div class="row"><button class="btn" data-act="close-entries">סגור</button></div>`;
  }

  // The dealer of the game being played; the games after it go on from the new dealer.
  async function changeDealer() {
    const t = curTour();
    const g = t && R.currentGame(t);
    if (!g) return;
    const cur = R.dealerOf(t, g);
    const pid = await ask({
      title: `מי מחלק במשחק ${R.gameNumber(t, g)}?`,
      body: 'במשחקים הבאים ממשיכים לפי הסדר מהמחלק הזה.',
      buttons: t.players.map((p) => ({ label: p.name, value: p.id, kind: p.id === cur ? 'primary' : '' })).concat([{ label: 'ביטול', value: null }]),
      cancel: null
    });
    const tt = curTour();
    if (!pid || pid === cur || !tt) return;
    changeTour(tt, (tour) => R.setDealer(tour, R.currentGame(tour), pid));
    toast('מחלק: ' + playerName(tt, pid));
  }

  // ---------- end-of-game sheet ----------
  // Works on a copy of the game (its points and its result); nothing changes until "save".
  // The winner is the last participant who got points; it can be changed.
  function openFinish(gid) {
    const t = curTour();
    if (!t) return;
    const g = gid ? R.findGame(t, gid) : R.currentGame(t);
    if (!g) return;
    const isEdit = !!g.result;
    sheet = {
      tid: t.id,
      gid: g.id,
      number: R.gameNumber(t, g),
      isEdit,
      manualWinner: isEdit,
      picking: false,
      draft: { points: clone(g.points), result: g.result ? clone(g.result) : { winnerId: null, hands: {} } }
    };
    if (!isEdit) setWinner(R.lastScorer(sheet.draft));
    sheetLayer = addLayer('<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" id="sheet"></div>', () => {
      sheet = null;
      sheetLayer = null;
    });
    renderSheet();
  }

  function closeSheet() {
    if (sheetLayer) removeLayer(sheetLayer);
  }

  function sheetTour() {
    return sheet && tourById(sheet.tid);
  }

  // A participant with no points in the game is marked "did not go down" (-70) automatically.
  // The mark follows the points until it is changed by hand (auto = false).
  function setWinner(id) {
    const t = sheetTour() || curTour();
    const res = sheet.draft.result;
    res.winnerId = id;
    t.players.forEach((p) => {
      if (p.id === id || res.hands[p.id]) return;
      res.hands[p.id] = { points: '', notDown: R.suggestNotDown(sheet.draft, p.id), auto: true };
    });
  }

  function renderSheet(focusPid) {
    const t = sheetTour();
    if (!t) { closeSheet(); return; }
    const s = sheet;
    const d = s.draft;
    const res = d.result;
    let h = `<h2>${s.isEdit ? 'תיקון' : 'סיום'} משחק ${s.number}</h2>`;
    if (res.winnerId && !s.picking) {
      h += `
        <div class="winner-line">
          <span>🏆 ניצח: <b>${esc(playerName(t, res.winnerId))}</b>${s.manualWinner ? '' : '<small class="muted"> · האחרון שקיבל נקודות</small>'}</span>
          <button class="btn sm" data-act="change-winner">שינוי</button>
        </div>`;
    } else {
      h += `<div class="label-line">${res.winnerId ? 'מי ניצח?' : 'אף אחד לא קיבל נקודות במשחק הזה. מי ניצח?'}</div>
        <div class="chips">${t.players.map((p) => `<button class="chip${res.winnerId === p.id ? ' on' : ''}" data-act="pick-winner" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
    }
    h += `<div class="label-line">${res.winnerId ? 'הנקודות במשחק, ומה נשאר ביד' : 'הנקודות שנרשמו במשחק'}</div>`;
    const order = t.players.slice().sort((a, b) => (b.id === res.winnerId) - (a.id === res.winnerId));
    order.forEach((p) => {
      const winner = p.id === res.winnerId;
      const chips = R.entriesOf(d, p.id).map((n, k) =>
        `<button class="add-chip num${n < 0 ? ' neg' : ''}" data-act="sheet-edit" data-pid="${p.id}" data-k="${k}" aria-label="תיקון ${n}">${n}</button>`).join('');
      h += `
        <div class="pl${winner ? ' closer' : ''}">
          <div class="pl-head"><b>${esc(p.name)}</b>${winner ? '<span class="closer-mark">ניצח</span>' : ''}<span class="pv num" id="pv-${p.id}"></span></div>
          <div class="pc-adds">${chips}<button class="add-chip plus" data-act="sheet-add" data-pid="${p.id}" aria-label="הוסף נקודות ל${esc(p.name)}">+</button></div>`;
      if (res.winnerId && !winner) {
        const e = res.hands[p.id];
        h += `
          <div class="hand-line">
            <span class="muted">נשאר ביד</span>
            <input class="pts" data-pid="${p.id}" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" placeholder="נק׳" value="${e.notDown ? '' : esc(e.points)}"${e.notDown ? ' disabled' : ''}>
            <button class="chip sm noset${e.notDown ? ' on' : ''}" data-act="toggle-notdown" data-id="${p.id}">לא ירד ${minus(R.NOT_DOWN_POINTS)}</button>
          </div>`;
      }
      h += '</div>';
    });
    h += `
      <p class="error" id="sheet-error"></p>
      <div class="row">
        <button class="btn primary" data-act="save-finish">${s.isEdit ? 'שמור' : 'סיים את המשחק'}</button>
        <button class="btn" data-act="close-sheet">ביטול</button>
      </div>`;
    document.getElementById('sheet').innerHTML = h;
    updateSheetPreview();
    if (focusPid) {
      const el = document.querySelector(`.pts[data-pid="${focusPid}"]`);
      if (el) el.focus();
    }
  }

  // What each participant gets for this game; before there is a winner, just the points scored.
  function updateSheetPreview() {
    const t = sheetTour();
    const d = sheet.draft;
    const res = d.result;
    t.players.forEach((p) => {
      const el = document.getElementById('pv-' + p.id);
      if (!el) return;
      if (!res.winnerId) { el.textContent = signed(R.gamePoints(d, p.id)); return; }
      const e = res.hands[p.id];
      const filled = p.id === res.winnerId || (e && (e.notDown || (e.points !== '' && e.points != null)));
      el.textContent = filled ? signed(R.playerGameScore(d, res, p.id)) : '';
    });
  }

  function firstEmptyHand() {
    const res = sheet.draft.result;
    const p = sheetTour().players.find((x) => {
      const e = res.hands[x.id];
      return x.id !== res.winnerId && e && !e.notDown && (e.points === '' || e.points == null);
    });
    return p && p.id;
  }

  function pickWinner(id) {
    sheet.manualWinner = true;
    sheet.picking = false;
    setWinner(id);
    renderSheet(firstEmptyHand());
  }

  // After the points in the sheet change: the automatic winner and "did not go down" marks follow them.
  function sheetPointsChanged() {
    const d = sheet.draft;
    if (!sheet.manualWinner) {
      const last = R.lastScorer(d);
      if (last && last !== d.result.winnerId) setWinner(last);
    }
    Object.keys(d.result.hands).forEach((pid) => {
      const e = d.result.hands[pid];
      if (!e.auto) return;
      const nd = R.suggestNotDown(d, pid);
      if (nd !== e.notDown) { e.notDown = nd; e.points = ''; }
    });
    renderSheet();
  }

  function sheetAdd(pid) {
    openPad({
      title: `${playerName(sheetTour(), pid)} · כמה נקודות?`,
      okLabel: 'הוסף',
      onSave: (n) => {
        if (!sheet) return;
        R.addPoints(sheet.draft, pid, n);
        sheetPointsChanged();
      }
    });
  }

  function sheetEdit(pid, k) {
    const value = R.entriesOf(sheet.draft, pid)[k];
    if (value == null) return;
    openPad({
      title: `${playerName(sheetTour(), pid)} · תיקון`,
      value: Math.abs(value),
      okLabel: 'שמור',
      onSave: (n) => {
        if (!sheet) return;
        if (!R.setEntry(sheet.draft, pid, k, n)) return;
        sheetPointsChanged();
      },
      onDelete: () => {
        if (!sheet) return;
        if (!R.removeEntry(sheet.draft, pid, k)) return;
        sheetPointsChanged();
      }
    });
  }

  function toggleNotDown(btn, pid) {
    const e = sheet.draft.result.hands[pid];
    e.notDown = !e.notDown;
    e.auto = false;
    e.points = '';
    btn.classList.toggle('on', e.notDown);
    const input = document.querySelector(`.pts[data-pid="${pid}"]`);
    input.disabled = e.notDown;
    input.value = '';
    if (!e.notDown) input.focus();
    document.getElementById('sheet-error').textContent = '';
    updateSheetPreview();
  }

  function saveFinish() {
    const t = sheetTour();
    const { gid, draft, isEdit, number } = sheet;
    const err = R.validateResult(t, draft.result);
    if (err) { document.getElementById('sheet-error').textContent = err; return; }
    closeSheet();
    changeTour(t, (tour) => {
      const g = R.findGame(tour, gid);
      R.finishGame(tour, g, draft.result, draft.points);
      if (tour.finishedAt) { tour.winnerIds = R.tournamentWinners(tour); R.touchMeta(tour); }
    });
    const winner = playerName(t, draft.result.winnerId);
    if (isEdit) toast('משחק ' + number + ' עודכן');
    else {
      const next = R.currentGame(t);
      const dealer = next ? playerName(t, R.dealerOf(t, next)) : '';
      toast(`${winner} ניצח במשחק ${number} · משחק ${number + 1}${dealer ? ', מחלק: ' + dealer : ''}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------- managing a tournament ----------
  async function addParticipant() {
    const t = curTour();
    if (!t) return;
    if (t.players.length >= MAX_PLAYERS) { toast('אפשר עד ' + MAX_PLAYERS + ' משתתפים'); return; }
    const name = await askText({
      title: 'משתתף חדש',
      body: 'מצטרף מהמשחק הנוכחי ומתחיל מאפס.',
      placeholder: 'שם',
      okLabel: 'הוסף',
      list: 'dlg-names',
      extra: `<datalist id="dlg-names">${ST.playerNames(state.tournaments).filter((n) => !R.playerByName(t, n)).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`,
      validate: (v) => (R.playerByName(t, v) ? 'כבר יש משתתף בשם הזה' : '')
    });
    if (!name) return;
    changeTour(curTour(), (tour) => R.addPlayer(tour, name));
    toast(name + ' הצטרף לטורניר');
  }

  async function renameTour() {
    const t = curTour();
    if (!t) return;
    const name = await askText({
      title: 'שם הטורניר',
      value: t.name,
      validate: (v) => {
        const other = T.findByName(state.tournaments, v);
        return other && other.id !== t.id ? 'כבר יש טורניר בשם הזה' : '';
      }
    });
    if (!name || name === t.name) return;
    changeTour(curTour(), (tour) => { tour.name = name; R.touchMeta(tour); });
  }

  async function finishTour() {
    const t = curTour();
    if (!t) return;
    const g = R.currentGame(t);
    if (g && R.hasPoints(g)) {
      const n = R.gameNumber(t, g);
      const choice = await ask({
        title: `משחק ${n} עוד לא נגמר`,
        body: 'נרשמו בו נקודות. אם הטורניר יסתיים עכשיו, המשחק הזה לא ייספר.',
        buttons: [
          { label: 'קודם אסיים את המשחק', value: 'game', kind: 'primary' },
          { label: 'סיים את הטורניר בלי המשחק הזה', value: 'drop' },
          { label: 'ביטול', value: null }
        ],
        cancel: null
      });
      if (!choice) return;
      if (choice === 'game') { openFinish(); return; }
    } else {
      if (!R.finishedGames(t).length) { toast('אפשר לסיים טורניר אחרי שמסתיים בו לפחות משחק אחד'); return; }
      const lead = R.standings(t, false)[0];
      const ok = await ask({
        title: 'לסיים את הטורניר?',
        body: `${playedText(R.finishedGames(t).length)}. מוביל: ${esc(lead.player.name)} עם <span class="num">${lead.total}</span> נקודות. אפשר להמשיך אותו גם אחר כך.`,
        buttons: [{ label: 'סיים את הטורניר', value: true, kind: 'primary' }, { label: 'ביטול', value: false }]
      });
      if (!ok) return;
    }
    const tt = curTour();
    if (!tt) return;
    changeTour(tt, R.finishTournament);
    window.scrollTo(0, 0);
    const w = winnerNames(curTour());
    if (w.length) toast('🏆 ' + andList(w) + (w.length > 1 ? ' ניצחו בטורניר' : ' ניצח בטורניר'));
  }

  function reopenTour() {
    const t = curTour();
    if (!t) return;
    changeTour(t, R.reopenTournament);
    toast('הטורניר ממשיך · משחק ' + R.gameNumber(curTour(), R.currentGame(curTour())));
  }

  async function deleteTour() {
    const t = curTour();
    if (!t) return;
    const n = R.finishedGames(t).length;
    const ok = await ask({
      title: `למחוק את הטורניר "${t.name}"?`,
      body: (n ? gamesText(n) + ' יימחקו גם מהסיכומים' : 'עוד לא הסתיים בו משחק') + (gh ? ', וגם מגיט' : '') + '. אי אפשר לבטל את זה.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    state.tournaments[state.tournaments.indexOf(t)] = T.tombstone(t);
    if (state.lastTournamentId === t.id) state.lastTournamentId = null;
    undoStack = [];
    SY.markDirty(state, t.id);
    persist();
    scheduleSync(0);
    toast('הטורניר נמחק');
    goHome();
  }

  // ---------- summaries ----------
  // Single-series horizontal bars that grow from the zero line (values may be negative).
  function barChart(items) {
    const vals = items.map((it) => it.value);
    const min = Math.min(0, ...vals);
    const max = Math.max(0, ...vals);
    const span = max - min || 1;
    const zero = (-min / span) * 100;
    return '<div class="bars">' + items.map((it) => {
      const w = (Math.abs(it.value) / span) * 100;
      const start = it.value >= 0 ? zero : zero - w;
      return `
        <div class="bar-row" title="${esc(it.label + ': ' + it.text)}">
          <span class="bl">${esc(it.label)}</span>
          <div class="bar-track">
            ${min < 0 ? `<span class="bar-zero" style="inset-inline-start:${zero}%"></span>` : ''}
            <span class="bar ${it.value >= 0 ? 'pos' : 'neg'}" style="inset-inline-start:${start}%;width:${w}%"></span>
          </div>
          <span class="bv num">${esc(it.text)}</span>
        </div>`;
    }).join('') + '</div>';
  }

  const li = (label, value) => `<li><span>${label}</span><b>${value}</b></li>`;

  VIEWS.reports = () => {
    const all = ST.overall(state.tournaments);
    const g = all.general;
    if (!g.games) return '<p class="empty">הסיכומים יופיעו אחרי שיסתיים המשחק הראשון.</p>';
    const tourWins = all.players.some((s) => s.tournamentWins);
    let h = backupNag();
    h += `<section class="card"><h3>כלל הנקודות · כל הטורנירים</h3><div class="table-scroll"><table class="data">
      <thead><tr><th>#</th><th>שחקן</th><th>נקודות</th><th>ניצחונות</th><th>משחקים</th><th>ממוצע</th>${tourWins ? '<th>זכה בטורנירים</th>' : ''}</tr></thead><tbody>`;
    all.players.forEach((s, i) => {
      h += `<tr${i === 0 ? ' class="top1"' : ''}><td>${i + 1}</td><td>${esc(s.name)}</td><td><span class="num">${s.points}</span></td><td>${s.wins}</td><td>${s.games}</td><td><span class="num">${round1(s.avg)}</span></td>${tourWins ? `<td>${s.tournamentWins}</td>` : ''}</tr>`;
    });
    h += `</tbody></table></div>
      <p class="muted" style="margin-top:8px">${gamesText(g.games)} ב${toursText(g.tournaments)}. ממוצע = נקודות למשחק. משחק שעוד לא הסתיים לא נספר.</p>
      ${barChart(all.players.map((s) => ({ label: s.name, value: s.points, text: String(s.points) })))}
    </section>`;

    h += '<h2 class="sec">ניצחונות ונקודות בכל טורניר</h2>';
    ST.byTournament(state.tournaments).filter((s) => s.games).forEach((s) => {
      const t = s.tournament;
      const winners = s.winners ? s.winners.map((w) => w.name) : [];
      h += `
        <section class="card">
          <div class="hist-top"><b class="tour-title">${esc(t.name)}</b><span>${t.finishedAt ? 'הסתיים ' + fmtDate(t.finishedAt) : 'פעיל'} · ${gamesText(s.games)}</span></div>
          ${winners.length ? `<div class="hist-winner">🏆 ${esc(andList(winners))}</div>` : ''}
          <div class="table-scroll"><table class="data">
            <thead><tr><th>#</th><th>שחקן</th><th>ניצחונות</th><th>נקודות</th><th>לא ירד</th></tr></thead><tbody>
            ${s.players.filter((p) => p.games).map((p) => `<tr><td>${p.place}</td><td>${esc(p.name)}</td><td>${p.wins}</td><td><span class="num">${p.points}</span></td><td>${p.notDowns}</td></tr>`).join('')}
          </tbody></table></div>
          <button class="btn sm link" data-act="open-tour" data-id="${t.id}">לטורניר ←</button>
        </section>`;
    });

    h += `<h2 class="sec">שיאים</h2><section class="card"><ul class="stat-list">
      ${li('טורנירים', g.tournaments + (g.finished ? ` (${g.finished} הסתיימו)` : ''))}
      ${li('משחקים', g.games)}
      ${li(`פעמים שמישהו לא ירד (${minus(R.NOT_DOWN_POINTS)})`, g.notDowns)}
      ${g.bestGame ? li('המשחק הכי טוב', `${esc(g.bestGame.name)}: <span class="num">${g.bestGame.points}</span> (${esc(g.bestGame.tournament)}, משחק ${g.bestGame.number})`) : ''}
      ${g.mostWins ? li('הכי הרבה ניצחונות בטורניר אחד', `${esc(g.mostWins.name)}: ${g.mostWins.wins} (${esc(g.mostWins.tournament)})`) : ''}
    </ul></section>`;
    return h;
  };

  // ---------- settings: git + backup ----------
  VIEWS.settings = () => {
    let h = `<section class="card form"><h2>שמירה בגיט</h2>
      <p class="muted">כל טורניר נשמר כקובץ במאגר גיטהאב שלך אחרי כל שינוי, כולל המשחק שבאמצע. כך שום דבר לא הולך לאיבוד, ואפשר להמשיך גם מטלפון אחר.</p>`;
    if (gh) {
      h += `<p>מחובר למאגר <b class="num">${esc(gh.owner + '/' + gh.repo)}</b>${gh.private === false ? ' <span style="color:var(--danger)">(ציבורי: כל אחד יכול לראות את התוצאות)</span>' : ''}</p>
        <p id="sync-status" class="muted">${esc(syncStatusText())}</p>
        <div class="row">
          <button class="btn primary" data-act="gh-sync">סנכרן עכשיו</button>
          <button class="btn danger" data-act="gh-disconnect">נתק</button>
        </div>`;
    } else {
      h += `
        <label for="gh-repo">מאגר (שם-משתמש/שם-מאגר)</label>
        <input type="text" id="gh-repo" class="ltr" placeholder="username/rummy-combos-data" autocomplete="off" autocapitalize="off" spellcheck="false">
        <label for="gh-token">טוקן גישה</label>
        <input type="password" id="gh-token" class="ltr" placeholder="github_pat_…" autocomplete="off">
        <p class="error" id="gh-error"></p>
        <button class="btn primary block" data-act="gh-connect">חבר ובדוק</button>
        <details>
          <summary>איך יוצרים מאגר וטוקן?</summary>
          <ol>
            <li>בגיטהאב צור מאגר חדש <b>פרטי</b> (Private), למשל <span class="num">rummy-combos-data</span>, והפעל את האפשרות להוסיף README.</li>
            <li>פתח <span class="num">Settings → Developer settings → Personal access tokens → Fine-grained tokens</span> ולחץ <span class="num">Generate new token</span>.</li>
            <li>תחת <span class="num">Repository access</span> בחר <span class="num">Only select repositories</span> ובחר רק את מאגר הנתונים.</li>
            <li>תחת <span class="num">Permissions → Contents</span> בחר <span class="num">Read and write</span>.</li>
            <li>בחר תוקף, צור את הטוקן, העתק אותו והדבק כאן.</li>
          </ol>
          <p class="muted">הטוקן נשמר רק בטלפון הזה. הוא לא נכנס לקוד של האפליקציה, ויש לו גישה רק למאגר הנתונים.</p>
        </details>`;
    }
    const live = T.live(state.tournaments);
    h += `</section>
      <section class="card"><h2>גיבוי לקובץ</h2>
        <p class="muted">קובץ אחד עם כל הטורנירים. אפשר לשלוח אותו לעצמך ולטעון אותו בטלפון אחר.</p>
        <div class="row">
          <button class="btn" data-act="export">ייצוא גיבוי</button>
          <label class="btn">ייבוא גיבוי<input type="file" id="import-file" accept=".json,application/json" hidden></label>
        </div>
      </section>
      <section class="card"><h2>במכשיר הזה</h2>
        <ul class="stat-list">
          ${li('טורנירים', live.length)}
          ${li('טורנירים פעילים', activeTours().length)}
          ${li('משחקים שהסתיימו', finishedCount())}
        </ul>
      </section>`;
    return h;
  };

  async function ghConnect() {
    const errEl = document.getElementById('gh-error');
    const repo = SY.parseRepo(document.getElementById('gh-repo').value);
    const token = document.getElementById('gh-token').value.trim();
    if (!repo) { errEl.textContent = 'כתוב את המאגר בצורה שם-משתמש/שם-מאגר'; return; }
    if (!token) { errEl.textContent = 'הדבק את הטוקן'; return; }
    errEl.textContent = 'בודק…';
    const cfg = { owner: repo.owner, repo: repo.repo, token };
    let info;
    try {
      info = await SY.check(cfg);
    } catch (e) {
      errEl.textContent = e.message;
      return;
    }
    cfg.private = info.private;
    state.sync.lastError = null;
    saveGh(cfg);
    toast('מחובר לגיט ✓');
    render();
    await pullFromGit(true);
  }

  async function ghDisconnect() {
    const ok = await ask({
      title: 'לנתק את הגיט?',
      body: 'הטורנירים יישארו בטלפון ובמאגר, אבל שינויים חדשים לא יישמרו בגיט עד שתתחבר שוב.',
      buttons: [{ label: 'נתק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    saveGh(null);
    render();
  }

  async function exportBackup() {
    const data = { app: 'rummycombos', version: 2, exportedAt: new Date().toISOString(), tournaments: state.tournaments };
    const name = 'rummycombos-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'גיבוי רמי קומבינציות' });
        markBackedUp();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    markBackedUp();
  }

  function markBackedUp() {
    state.backupGames = finishedCount();
    persist();
    toast('קובץ הגיבוי נוצר');
  }

  // Accepts this version's file and the first version's (evenings), which is converted.
  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('הקובץ לא תקין'); return; }
      let incoming = null;
      if (data && Array.isArray(data.tournaments) && data.version >= 2) incoming = data.tournaments;
      else if (data && Array.isArray(data.history)) incoming = T.fromV1(data);
      if (!incoming) { toast('זה לא קובץ גיבוי של רמי קומבינציות'); return; }
      const m = T.mergeLists(state.tournaments, incoming);
      state.tournaments = m.list;
      m.changed.forEach((id) => SY.markDirty(state, id));
      persist();
      scheduleSync(0);
      toast(m.added ? 'נוספו ' + toursText(m.added) : m.changed.length ? 'עודכנו ' + toursText(m.changed.length) : 'כל מה שבקובץ כבר קיים');
      render();
    };
    reader.readAsText(file);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    switch (d.act) {
      case 'back': back(); break;
      case 'home': goHome(); break;
      case 'go': go(d.to); break;
      case 'new-tour': startSetup(state.lastPlayers); break;
      case 'remove-player': removePlayer(+d.i); break;
      case 'pick-dealer': view.firstDealer = +d.i; render(); break;
      case 'add-player': view.names.push(''); render(); document.querySelector(`.pname[data-i="${view.names.length - 1}"]`).focus(); break;
      case 'start-tour': startTour(); break;
      case 'open-tour': openTour(d.id); break;
      case 'add': addFor(d.pid); break;
      case 'take': takeFrom(d.pid); break;
      case 'change-dealer': changeDealer(); break;
      case 'fix-last': fixLast(false); break;
      case 'delete-last': fixLast(true); break;
      case 'entries': openEntries(d.pid); break;
      case 'entry-edit': editEntry(d.pid, +d.k); break;
      case 'close-entries': closeEntries(); break;
      case 'undo': undo(); break;
      case 'open-finish': openFinish(); break;
      case 'edit-game': openFinish(d.gid); break;
      case 'close-sheet': closeSheet(); break;
      case 'change-winner': sheet.picking = true; renderSheet(); break;
      case 'pick-winner': pickWinner(d.id); break;
      case 'toggle-notdown': toggleNotDown(el, d.id); break;
      case 'save-finish': saveFinish(); break;
      case 'sheet-add': sheetAdd(d.pid); break;
      case 'sheet-edit': sheetEdit(d.pid, +d.k); break;
      case 'pad-key': padKey(d.k); break;
      case 'pad-ok': padOk(); break;
      case 'pad-delete': padDelete(); break;
      case 'pad-cancel': padCancel(); break;
      case 'tour-add-player': addParticipant(); break;
      case 'tour-rename': renameTour(); break;
      case 'tour-finish': finishTour(); break;
      case 'tour-reopen': reopenTour(); break;
      case 'tour-delete': deleteTour(); break;
      case 'rematch': { const t = curTour(); if (t) startSetup(t.players.map((p) => p.name)); break; }
      case 'gh-connect': ghConnect(); break;
      case 'gh-sync': pullFromGit(false); break;
      case 'gh-disconnect': ghDisconnect(); break;
      case 'export': exportBackup(); break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('pname')) {
      view.names[+t.dataset.i] = t.value;
      const name = document.getElementById('tour-name');
      if (name) name.placeholder = namePlaceholder();
    } else if (t.id === 'tour-name') {
      view.tourName = t.value;
    } else if (t.classList.contains('pts') && sheet) {
      t.value = t.value.replace(/\D/g, '');
      const hand = sheet.draft.result.hands[t.dataset.pid];
      hand.points = t.value;
      hand.auto = false;
      document.getElementById('sheet-error').textContent = '';
      updateSheetPreview();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'import-file' && t.files && t.files[0]) { importBackup(t.files[0]); t.value = ''; }
  });

  // With the number pad open, the keyboard types into it.
  document.addEventListener('keydown', (e) => {
    if (!pad || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) padKey(e.key);
    else if (e.key === 'Backspace') padKey('back');
    else if (e.key === 'Enter') padOk();
    else if (e.key === 'Escape') padCancel();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });

  // Enter moves to the next name / points field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    const cls = t.classList.contains('pts') ? '.pts' : t.classList.contains('pname') || t.id === 'tour-name' ? '.pname' : null;
    if (!cls) return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll(cls + ':not(:disabled)'));
    const next = t.id === 'tour-name' ? all[0] : all[all.indexOf(t) + 1];
    if (next) next.focus();
    else t.blur();
  });

  // ---------- start ----------
  if (state.converted) {
    delete state.converted;
    persist();
    setTimeout(() => toast('הנתונים הקודמים הועברו לטורנירים'), 300);
  }
  const last = tourById(state.lastTournamentId);
  if (last && !last.deleted && !last.finishedAt) {
    stack = [{ name: 'home' }];
    view = { name: 'tournament', id: last.id };
    history.pushState({ rummy: 1 }, '');
  }
  render();
  if (gh) pullFromGit(true);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
