/* Rummy Combos — the UI. Every screen is rendered from state; clicks are routed by data-act.
   Words on screen: a game object is an "evening" (ערב) and each of its rounds is a "game" (משחק). */
(function () {
  'use strict';

  const R = window.Rummy;
  const ST = window.RummyStats;
  const T = window.RummyTournaments;
  const SY = window.RummySync;

  const KEY = 'rummycombos.v1';
  const GH_KEY = 'rummycombos.github';
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const UNDO_LIMIT = 50;
  const BACKUP_NAG = 10;

  let state = loadState();
  let gh = loadGh();
  let undoStack = [];
  let view = { name: 'home' };
  let stack = [];
  let overlays = [];
  let sheet = null;
  let sheetLayer = null;

  const $view = document.getElementById('view');
  const $overlay = document.getElementById('overlay-root');

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const signed = (n) => (n > 0 ? '+' + n : String(n));
  const pct = (x) => Math.round(x * 100) + '%';
  const round1 = (x) => String(Math.round(x * 10) / 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const names = (g) => g.players.map((p) => p.name);
  const findGame = (id) => state.history.find((g) => g.id === id);
  const tourName = (g) => T.nameOf(state.tournaments, g);
  const winsText = (n) => (n === 1 ? 'ניצחון אחד' : n + ' ניצחונות');
  const eveningsText = (n) => (n === 1 ? 'ערב אחד' : n + ' ערבים');
  const gamesText = (n) => (n === 1 ? 'משחק אחד' : n + ' משחקים');
  const playedText = (n) => (n === 1 ? 'שוחק משחק אחד' : 'שוחקו ' + n + ' משחקים');
  const playerName = (g, id) => (R.playerById(g, id) || { name: '' }).name;

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
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- storage ----------
  function loadState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* empty or blocked storage */ }
    if (!s || !Array.isArray(s.history)) s = { current: null, history: [], lastPlayers: [], backupCount: 0 };
    if (!Array.isArray(s.tournaments)) s.tournaments = [];
    s.sync = Object.assign(SY.emptySync(), s.sync || {});
    s.history.forEach(R.normalize);
    R.normalize(s.current);
    return s;
  }

  function toursChanged() {
    state.sync.tournamentsVersion++;
  }

  // Gives every game a tournament (games from before tournaments, pulled from git or imported)
  // and queues whatever changed for git. Returns true when something changed.
  function fixTournaments() {
    const res = T.ensure(state.tournaments, state.history.concat(state.current ? [state.current] : []));
    res.games.forEach((id) => {
      if (state.current && state.current.id === id) state.sync.currentVersion++;
      else if (!state.sync.unsyncedGames.includes(id)) state.sync.unsyncedGames.push(id);
    });
    if (res.tournaments) toursChanged();
    return res.games.length > 0 || res.tournaments;
  }

  // The tournament of the open game, or of the last game that was started.
  function homeTournament() {
    const t = T.find(state.tournaments, state.current ? state.current.tournamentId : state.lastTournamentId);
    return t && !t.deleted ? t : null;
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

  // ---------- current game changes (undoable) ----------
  function changeCurrent(fn) {
    undoStack.push(JSON.stringify(state.current));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    const out = fn(state.current);
    R.touch(state.current);
    currentSaved();
    return out;
  }

  function currentSaved() {
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    render();
  }

  function undo() {
    if (!undoStack.length) return;
    state.current = JSON.parse(undoStack.pop());
    R.touch(state.current);
    currentSaved();
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
          <input type="text" id="dlg-text" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}" maxlength="40" autocomplete="off" enterkeyhint="done">
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
    syncTimer = setTimeout(runSync, delay == null ? 1200 : delay);
  }

  async function runSync() {
    if (!gh) return;
    if (syncing) { syncAgain = true; return; }
    if (!SY.pending(state)) { renderSyncBadge(); return; }
    syncing = true;
    renderSyncBadge();
    try {
      await SY.flush(state, gh);
    } catch (e) {
      state.sync.lastError = e.message;
    }
    syncing = false;
    persist();
    renderSyncBadge();
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }

  async function pullFromGit(quiet) {
    if (!gh || syncing) return;
    syncing = true;
    renderSyncBadge();
    let remoteCurrent = null;
    try {
      const res = await SY.pull(state, gh);
      remoteCurrent = R.normalize(res.remoteCurrent);
      state.history.forEach(R.normalize);
      fixTournaments();
      persist();
      if (res.added) toast('נטענו מגיט ' + eveningsText(res.added));
      else if (!quiet) toast('הסנכרון הסתיים');
    } catch (e) {
      state.sync.lastError = e.message;
      persist();
      if (!quiet) toast(e.message);
    }
    syncing = false;
    await offerRemoteCurrent(remoteCurrent);
    render();
    scheduleSync(0);
  }

  // An evening in progress saved from another phone can be continued here.
  async function offerRemoteCurrent(remote) {
    if (!remote || remote.finishedAt || !Array.isArray(remote.rounds)) return;
    if (findGame(remote.id)) return;
    const local = state.current;
    if (local && local.id === remote.id) {
      if ((remote.updatedAt || '') > (local.updatedAt || '')) {
        state.current = remote;
        undoStack = [];
        state.sync.syncedVersion = state.sync.currentVersion;
        fixTournaments();
        persist();
        toast('הערב הפתוח עודכן מגיט');
      }
      return;
    }
    if (local && (local.updatedAt || '') >= (remote.updatedAt || '')) return;
    const take = await ask({
      title: 'נמצא בגיט ערב פתוח',
      body: `${esc(names(remote).join(', '))} · ${playedText(R.playedCount(remote))}.<br>להמשיך אותו בטלפון הזה?${local ? ' הערב הפתוח כאן יוחלף.' : ''}`,
      buttons: [{ label: 'המשך אותו כאן', value: true, kind: 'primary' }, { label: 'לא', value: false }]
    });
    if (!take) return;
    state.current = remote;
    undoStack = [];
    state.sync.syncedVersion = state.sync.currentVersion;
    fixTournaments();
    if (remote.tournamentId) state.lastTournamentId = remote.tournamentId;
    persist();
    if (!stack.length) history.pushState({ rummy: 1 }, '');
    stack = [{ name: 'home' }];
    view = { name: 'game' };
  }

  function syncStatusText() {
    const s = state.sync;
    const n = SY.pending(state);
    if (syncing) return 'שומר בגיט…';
    if (s.lastError && n) return `לא נשמר: ${s.lastError}. ממתינים לשמירה: ${n}`;
    if (n) return 'ממתינים לשמירה: ' + n;
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

  function render() {
    const fn = VIEWS[view.name] || VIEWS.home;
    $view.innerHTML = fn();
    document.getElementById('btn-back').hidden = view.name === 'home';
    renderSyncBadge();
  }

  function rankList(g, withPlace) {
    return '<ol class="mini-rank">' + R.ranking(g).map((r) =>
      `<li>${withPlace ? r.place + '. ' : ''}${esc(r.player.name)} <b class="num">${r.total}</b></li>`).join('') + '</ol>';
  }

  function lastWinnerCard(g) {
    const winner = R.ranking(g)[0].player.name;
    return `
      <button class="card" data-act="view-game" data-id="${g.id}">
        <div class="label">ניצח בערב הקודם · טורניר ${esc(tourName(g))}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${fmtDate(g.finishedAt, true)} · ${gamesText(g.rounds.length)}</div>
        ${rankList(g, false)}
      </button>`;
  }

  // The top three of a tournament; opens its reports.
  function tournamentCard(id) {
    const row = T.overview(state.tournaments, state.history).find((o) => o.tournament.id === id);
    if (!row || !row.games) return '';
    return `
      <button class="card" data-act="tour-reports" data-id="${id}">
        <div class="label">המובילים בטורניר ${esc(row.tournament.name)} · ${eveningsText(row.games)}</div>
        <ol class="mini-rank stack">${row.top.map((s, i) => `<li>${i + 1}. ${esc(s.name)} <b>${winsText(s.wins)}</b></li>`).join('')}</ol>
        <div class="muted tour-line">לדוחות של הטורניר ←</div>
      </button>`;
  }

  function backupNag() {
    const unsaved = state.history.length - (state.backupCount || 0);
    if (gh || unsaved < BACKUP_NAG) return '';
    return `
      <button class="card warn" data-act="go" data-to="settings">
        <b>${unsaved} ערבים לא מגובים</b>
        <div class="muted">הם שמורים רק בטלפון הזה. חבר את האפליקציה לגיט או ייצא קובץ גיבוי.</div>
      </button>`;
  }

  VIEWS.home = () => {
    const g = state.current;
    let h = '';
    if (g) {
      const i = R.currentIndex(g);
      h += `
        <button class="card" data-act="go" data-to="game">
          <div class="label">ערב פתוח</div>
          <div class="winner-name" style="font-size:1.25rem">משחק ${i + 1} · מחלק: ${esc(R.dealer(g, i).name)}</div>
          <div class="muted">${esc(names(g).join(' · '))}</div>
          <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
        </button>
        <button class="btn primary big" data-act="go" data-to="game">המשך ערב</button>
        <div class="row"><button class="btn" data-act="new-game">ערב חדש</button></div>`;
    } else {
      h += '<button class="btn primary big" data-act="new-game">ערב חדש</button>';
    }
    // Last winner and leaders of the current tournament; any last evening when it has none yet.
    const done = ST.finished(state.history);
    const ht = homeTournament();
    const inTour = ht ? T.gamesOf(done, ht.id) : [];
    const last = inTour.length ? inTour[inTour.length - 1] : ST.lastGame(done);
    if (last) h += '<div style="height:12px"></div>' + lastWinnerCard(last) + tournamentCard(last.tournamentId);
    h += backupNag();
    h += `
      <div class="tiles">
        <button class="btn" data-act="go" data-to="reports"><span class="ic">📊</span>דוחות</button>
        <button class="btn" data-act="go" data-to="tournaments"><span class="ic">🏅</span>טורנירים</button>
        <button class="btn" data-act="go" data-to="history"><span class="ic">🗂️</span>היסטוריה</button>
        <button class="btn" data-act="go" data-to="settings"><span class="ic">☁️</span>גיט וגיבוי</button>
      </div>`;
    return h;
  };

  // ---------- setup ----------
  VIEWS.setup = () => {
    const known = ST.playerNames(state.history);
    const rows = view.names.map((n, i) => `
      <li>
        <button class="deal-chip${view.firstDealer === i ? ' on' : ''}" data-act="pick-dealer" data-i="${i}" aria-pressed="${view.firstDealer === i}">מחלק</button>
        <input class="pname" data-i="${i}" value="${esc(n)}" placeholder="שחקן ${i + 1}" list="known-names" maxlength="20" autocomplete="off" enterkeyhint="next">
        <button class="btn icon" data-act="move" data-i="${i}" data-d="-1" aria-label="הזז למעלה"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn icon" data-act="move" data-i="${i}" data-d="1" aria-label="הזז למטה"${i === view.names.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn icon danger" data-act="remove-player" data-i="${i}" aria-label="הסר"${view.names.length <= MIN_PLAYERS ? ' disabled' : ''}>✕</button>
      </li>`).join('');
    return `
      <section class="card form" id="tour-pick">${tourPickHtml()}</section>
      <h2>שחקנים</h2>
      <p class="muted">לפי סדר הישיבה, כי החלוקה עוברת לפי הסדר. לחץ "מחלק" ליד מי שמחלק ראשון.</p>
      <ul class="player-list">${rows}</ul>
      <datalist id="known-names">${known.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${view.names.length < MAX_PLAYERS ? '<button class="btn block" data-act="add-player">+ הוסף שחקן</button>' : ''}
      <p class="muted" style="margin-top:12px">אין מספר משחקים קבוע: משחקים כמה שרוצים ומסיימים את הערב מתי שמחליטים.</p>
      <button class="btn primary big" data-act="start-game">התחל ערב</button>
      <p class="error" id="setup-error"></p>`;
  };

  // tourSel = a tournament id or 'new'. Until the user picks one (tourManual), it follows the
  // lineup: the tournament these players played in last, or a new one named after them.
  function tourPickHtml() {
    const open = T.live(state.tournaments).filter((t) => !t.archived);
    let h = `
      <label for="tour-sel">טורניר</label>
      <select id="tour-sel" data-field="tourSel">
        ${open.map((t) => `<option value="${t.id}"${view.tourSel === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
        <option value="new"${view.tourSel === 'new' ? ' selected' : ''}>+ טורניר חדש…</option>
      </select>`;
    if (view.tourSel === 'new') {
      h += `
        <input type="text" id="tour-name" class="tour-name" value="${esc(view.tourName)}" placeholder="שם הטורניר, למשל: אצל סבתא" maxlength="40" autocomplete="off" enterkeyhint="done">
        <p class="muted tour-line">${view.tourManual ? 'ייפתח טורניר חדש בשם הזה.' : 'הרכב חדש, ולכן ייפתח לו טורניר חדש. אפשר לשנות את השם או לבחור טורניר קיים.'}</p>`;
    } else if (!view.tourManual) {
      h += '<p class="muted tour-line">נבחר לבד לפי ההרכב. אפשר לבחור טורניר אחר.</p>';
    }
    return h;
  }

  function refreshTourPick() {
    const el = document.getElementById('tour-pick');
    if (el) el.innerHTML = tourPickHtml();
  }

  function autoTournament(v) {
    const ns = v.names.map(R.cleanName);
    if (!v.tourNameEdited) v.tourName = T.defaultName(ns);
    if (v.tourManual) return;
    const t = T.suggest(state.tournaments, state.history, ns);
    v.tourSel = t ? t.id : 'new';
  }

  function startSetup(list, tourId) {
    const ns = (list || []).slice(0, MAX_PLAYERS);
    while (ns.length < MIN_PLAYERS) ns.push('');
    const t = T.find(state.tournaments, tourId);
    const keep = t && !t.deleted && !t.archived;
    const params = { names: ns, firstDealer: 0, tourSel: keep ? t.id : 'new', tourManual: keep, tourName: '', tourNameEdited: false };
    autoTournament(params);
    go('setup', params);
  }

  function movePlayer(i, d) {
    const j = i + d;
    if (j < 0 || j >= view.names.length) return;
    const n = view.names;
    [n[i], n[j]] = [n[j], n[i]];
    if (view.firstDealer === i) view.firstDealer = j;
    else if (view.firstDealer === j) view.firstDealer = i;
    autoTournament(view);
    render();
  }

  function removePlayer(i) {
    if (view.names.length <= MIN_PLAYERS) return;
    view.names.splice(i, 1);
    if (view.firstDealer === i) view.firstDealer = 0;
    else if (view.firstDealer > i) view.firstDealer--;
    autoTournament(view);
    render();
  }

  // The tournament chosen on the setup screen; a new one is created here.
  function setupTournament(ns) {
    let t = view.tourSel !== 'new' ? T.find(state.tournaments, view.tourSel) : null;
    if (!t || t.deleted) {
      const name = R.cleanName(view.tourName) || T.defaultName(ns);
      t = T.findByName(state.tournaments, name);
      if (!t) {
        t = T.make(name, view.tourNameEdited ? null : T.lineupKey(ns));
        state.tournaments.push(t);
        toursChanged();
      }
    }
    if (t.archived) {
      t.archived = false;
      T.touch(t);
      toursChanged();
    }
    return t;
  }

  function startGame() {
    const ns = view.names.map(R.cleanName);
    let err = '';
    if (ns.some((n) => !n)) err = 'יש שורה בלי שם. מלא אותה או הסר אותה.';
    else {
      const dup = ns.find((n, i) => ns.indexOf(n) !== i);
      if (dup) err = `השם "${dup}" מופיע פעמיים`;
    }
    if (err) { document.getElementById('setup-error').textContent = err; return; }
    const first = ns[view.firstDealer];
    const t = setupTournament(ns);
    state.current = R.newGame(ns, { firstDealer: view.firstDealer });
    state.current.tournamentId = t.id;
    state.current.tournamentName = t.name;
    state.lastTournamentId = t.id;
    state.lastPlayers = ns;
    undoStack = [];
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    stack = [{ name: 'home' }];
    replace('game');
    toast('בהצלחה! ' + first + ' מחלק ראשון · ' + t.name);
  }

  async function newGame() {
    if (state.current) {
      const played = R.playedCount(state.current);
      const buttons = [];
      if (played) buttons.push({ label: 'לסיים ולשמור אותו', value: 'finish', kind: 'primary' });
      buttons.push({ label: 'למחוק אותו', value: 'discard', kind: 'danger' }, { label: 'ביטול', value: null });
      const choice = await ask({ title: 'יש ערב פתוח', body: 'מה לעשות עם הערב הפתוח לפני שמתחילים חדש?', buttons, cancel: null });
      if (!choice) return;
      if (choice === 'finish') {
        const g = await finishGame({ show: false });
        if (!g) return;
        toast('הערב נשמר · ניצח ' + playerName(g, g.winnerId));
      } else if (!(await confirmDiscard())) {
        return;
      }
    }
    startSetup(state.lastPlayers);
  }

  async function confirmDiscard() {
    const ok = await ask({
      title: 'למחוק את הערב הפתוח?',
      body: 'הניקוד של הערב הזה יימחק ולא יישמר בהיסטוריה.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return false;
    state.current = null;
    undoStack = [];
    state.sync.currentVersion++;
    persist();
    scheduleSync();
    return true;
  }

  // ---------- game screen ----------
  // The points one player scored in a game, as small buttons (tap = fix or delete).
  function addsChips(round, pid, act) {
    return R.addsOf(round, pid).map((n, k) =>
      `<button class="add-chip num" data-act="${act}" data-pid="${pid}" data-k="${k}" aria-label="תיקון ${n}">${n}</button>`).join('');
  }

  const minus = (n) => `<span class="num">-${n}</span>`;

  VIEWS.game = () => {
    const g = state.current;
    if (!g) { view = { name: 'home' }; return VIEWS.home(); }
    const i = R.currentIndex(g);
    const r = g.rounds[i];
    const played = R.playedCount(g);
    const totals = R.totals(g);
    const best = Math.max(...g.players.map((p) => totals[p.id]));
    const dealerIdx = R.dealerIndex(g, i);
    let h = `
      <section class="status">
        <div class="status-top">
          <span class="round-no">משחק ${i + 1}</span>
          <span class="muted">${played ? playedText(played) : 'המשחק הראשון בערב'}</span>
        </div>
        <div class="dealer">מחלק: ${esc(R.dealer(g, i).name)}</div>
        <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
      </section>
      <div class="pcards">`;
    g.players.forEach((p, pi) => {
      const lead = played && totals[p.id] === best;
      h += `
        <div class="pcard${pi === dealerIdx ? ' dealing' : ''}">
          <div class="pc-top">
            <b class="pc-name">${esc(p.name)}</b>
            ${pi === dealerIdx ? '<span class="deal-mark">מחלק</span>' : ''}
          </div>
          <div class="pc-sum"><span class="num">${R.addsSum(r, p.id)}</span><small>במשחק</small></div>
          <div class="pc-total${lead ? ' lead' : ''}">בערב: <b class="num">${totals[p.id]}</b>${lead ? ' 👑' : ''}</div>
          <div class="pc-adds">${addsChips(r, p.id, 'edit-add')}</div>
          <button class="btn primary pc-plus" data-act="add-points" data-pid="${p.id}">+ נקודות</button>
        </div>`;
    });
    h += `</div>
      <button class="btn primary big" data-act="open-round" data-i="${i}">סיום משחק ${i + 1}</button>`;
    h += scoreTableHtml(g, true);
    h += `
      <div class="legend">
        <span>מסגרת = ניצח במשחק</span><span>✕ = לא ירד (${minus(R.NOT_DOWN_POINTS)})</span><span>לחיצה על שורה = עריכה</span>
      </div>
      <div class="row">
        <button class="btn" data-act="undo"${undoStack.length ? '' : ' disabled'}>↶ בטל פעולה</button>
        ${played ? '<button class="btn" data-act="finish">סיים את הערב</button>' : ''}
      </div>`;
    if (!played) h += '<button class="btn block danger" data-act="discard">מחק את הערב</button>';
    return h;
  };

  // A row per finished game; while the evening is open, the open game is the last row,
  // showing the points scored in it so far.
  function scoreTableHtml(g, editable) {
    const table = R.scoreTable(g);
    const cur = editable ? R.currentIndex(g) : -1;
    const played = R.playedCount(g);
    let h = '<div class="table-wrap"><table class="score"><thead><tr><th class="c-no">#</th>';
    g.players.forEach((p) => { h += `<th>${esc(p.name)}</th>`; });
    h += '</tr></thead><tbody>';
    g.rounds.forEach((r, i) => {
      const row = table.rows[i];
      const res = r.result;
      if (!res && i !== cur) return;
      h += `<tr class="${res ? 'played' : 'current'}"${editable ? ` data-act="open-round" data-i="${i}"` : ''}>`;
      h += `<td class="c-no">${i + 1}</td>`;
      g.players.forEach((p, pi) => {
        if (res) {
          const e = res.entries[p.id];
          const nd = !!(e && e.notDown);
          const cls = [p.id === res.closerId ? 'win' : '', nd ? 'nd' : ''].join(' ').trim();
          h += `<td${cls ? ` class="${cls}"` : ''}><span class="tot num">${row.totals[p.id]}</span><span class="delta"><span class="num">${signed(row.scores[p.id])}</span>${nd ? ' ✕' : ''}</span></td>`;
        } else {
          const sum = R.addsSum(r, p.id);
          h += `<td>${sum ? `<span class="live num">+${sum}</span>` : ''}${R.dealerIndex(g, i) === pi ? '<span class="deal-mark">מחלק</span>' : ''}</td>`;
        }
      });
      h += '</tr>';
    });
    h += '</tbody>';
    if (played) {
      const max = Math.max(...g.players.map((p) => table.totals[p.id]));
      const isLead = (p) => (g.winnerId ? p.id === g.winnerId : table.totals[p.id] === max);
      h += '<tfoot><tr><th>סה״כ</th>' +
        g.players.map((p) => `<th class="num${isLead(p) ? ' lead' : ''}">${table.totals[p.id]}</th>`).join('') + '</tr></tfoot>';
    }
    return h + '</table></div>';
  }

  // ---------- number pad ----------
  // opts: { title, value, okLabel, onSave(n), onDelete() (optional: shows a delete button) }
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
          <button class="key ok" data-act="pad-ok">${esc(opts.okLabel || 'הוסף')}</button>
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
    if (!R.validPoints(n)) { document.getElementById('pad-error').textContent = 'הזן מספר גדול מאפס'; return; }
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

  // ---------- points during the open game ----------
  function addPointsFor(pid) {
    const g = state.current;
    const i = R.currentIndex(g);
    const name = playerName(g, pid);
    openPad({
      title: `${name} · כמה נקודות?`,
      okLabel: 'הוסף',
      onSave: (n) => {
        changeCurrent((game) => R.addPoints(game.rounds[i], pid, n));
        toast(`${name}: נוספו ${n}`);
      }
    });
  }

  function editAdd(pid, k) {
    const g = state.current;
    const i = R.currentIndex(g);
    const value = R.addsOf(g.rounds[i], pid)[k];
    if (value == null) return;
    const name = playerName(g, pid);
    openPad({
      title: `${name} · תיקון`,
      value,
      okLabel: 'שמור',
      onSave: (n) => changeCurrent((game) => R.setPoints(game.rounds[i], pid, k, n)),
      onDelete: () => {
        changeCurrent((game) => R.removePoints(game.rounds[i], pid, k));
        toast('הרישום נמחק');
      }
    });
  }

  // ---------- end-of-game sheet ----------
  // Works on a copy of the game (its points and its result); nothing changes until "save".
  function openRound(i) {
    const r = state.current.rounds[i];
    sheet = {
      i,
      isEdit: !!r.result,
      draft: { adds: clone(r.adds || {}), result: r.result ? clone(r.result) : { closerId: null, entries: {} } }
    };
    sheetLayer = addLayer('<div class="backdrop" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" id="sheet"></div>', () => {
      sheet = null;
      sheetLayer = null;
    });
    renderSheet();
  }

  function closeSheet() {
    if (sheetLayer) removeLayer(sheetLayer);
  }

  function renderSheet(focusPid) {
    const g = state.current;
    const s = sheet;
    const d = s.draft;
    const res = d.result;
    let h = `<h2>${s.isEdit ? 'עריכת' : 'סיום'} משחק ${s.i + 1}</h2>
      <div class="muted">מחלק: ${esc(R.dealer(g, s.i).name)}</div>
      <div class="label-line">מי ניצח בסיבוב זה?</div>
      <div class="chips">${g.players.map((p) => `<button class="chip${res.closerId === p.id ? ' on' : ''}" data-act="pick-closer" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      <div class="label-line">${res.closerId ? 'הנקודות במשחק, ומה נשאר ביד' : 'הנקודות שנרשמו במשחק'}</div>`;
    g.players.forEach((p) => {
      const closer = p.id === res.closerId;
      h += `
        <div class="pl${closer ? ' closer' : ''}">
          <div class="pl-head"><b>${esc(p.name)}</b>${closer ? '<span class="closer-mark">ניצח</span>' : ''}<span class="pv num" id="pv-${p.id}"></span></div>
          <div class="pc-adds">${addsChips(d, p.id, 'sheet-edit-add')}<button class="add-chip plus" data-act="sheet-add" data-pid="${p.id}" aria-label="הוסף נקודות ל${esc(p.name)}">+</button></div>`;
      if (res.closerId && !closer) {
        const e = res.entries[p.id];
        h += `
          <div class="hand-line">
            <span class="muted">נשאר ביד</span>
            <input class="pts" data-pid="${p.id}" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" placeholder="נק׳" value="${e.notDown ? '' : esc(e.points)}"${e.notDown ? ' disabled' : ''}>
            <button class="chip sm noset${e.notDown ? ' on' : ''}" data-act="toggle-notdown" data-id="${p.id}">לא ירד ${minus(R.NOT_DOWN_POINTS)}</button>
          </div>`;
      }
      h += '</div>';
    });
    if (!res.closerId) h += '<p class="muted" style="margin-top:12px">בחר מי ניצח, ואז הזן כמה נקודות נשארו ביד לכל השאר.</p>';
    h += `
      <p class="error" id="sheet-error"></p>
      <div class="row">
        <button class="btn primary" data-act="save-round">שמור</button>
        <button class="btn" data-act="close-sheet">ביטול</button>
      </div>`;
    document.getElementById('sheet').innerHTML = h;
    updateSheetPreview();
    if (focusPid) {
      const el = document.querySelector(`.pts[data-pid="${focusPid}"]`);
      if (el) el.focus();
    }
  }

  // What each player gets for this game; before a closer is picked, just the points scored.
  function updateSheetPreview() {
    const g = state.current;
    const d = sheet.draft;
    const res = d.result;
    g.players.forEach((p) => {
      const el = document.getElementById('pv-' + p.id);
      if (!el) return;
      if (!res.closerId) { el.textContent = signed(R.addsSum(d, p.id)); return; }
      const e = res.entries[p.id];
      const filled = p.id === res.closerId || (e && (e.notDown || (e.points !== '' && e.points != null)));
      el.textContent = filled ? signed(R.playerRoundPoints(d, res, p.id)) : '';
    });
  }

  function firstEmptyHand() {
    const res = sheet.draft.result;
    const p = state.current.players.find((x) => {
      const e = res.entries[x.id];
      return x.id !== res.closerId && e && !e.notDown && (e.points === '' || e.points == null);
    });
    return p && p.id;
  }

  // A player who scored nothing in this game is marked "did not go down" (−70) automatically.
  // The mark follows the points until it is changed by hand (auto = false).
  function pickCloser(id) {
    const res = sheet.draft.result;
    res.closerId = id;
    state.current.players.forEach((p) => {
      if (p.id === id || res.entries[p.id]) return;
      res.entries[p.id] = { points: '', notDown: R.suggestNotDown(sheet.draft, p.id), auto: true };
    });
    renderSheet(firstEmptyHand());
  }

  function sheetAddsChanged(pid) {
    const e = sheet.draft.result.entries[pid];
    if (e && e.auto) {
      const nd = R.suggestNotDown(sheet.draft, pid);
      if (nd !== e.notDown) {
        e.notDown = nd;
        e.points = '';
      }
    }
    renderSheet();
  }

  function sheetAdd(pid) {
    const name = playerName(state.current, pid);
    openPad({
      title: `${name} · כמה נקודות?`,
      okLabel: 'הוסף',
      onSave: (n) => {
        if (!sheet) return;
        R.addPoints(sheet.draft, pid, n);
        sheetAddsChanged(pid);
      }
    });
  }

  function sheetEditAdd(pid, k) {
    const value = R.addsOf(sheet.draft, pid)[k];
    if (value == null) return;
    openPad({
      title: `${playerName(state.current, pid)} · תיקון`,
      value,
      okLabel: 'שמור',
      onSave: (n) => {
        if (!sheet) return;
        R.setPoints(sheet.draft, pid, k, n);
        sheetAddsChanged(pid);
      },
      onDelete: () => {
        if (!sheet) return;
        R.removePoints(sheet.draft, pid, k);
        sheetAddsChanged(pid);
      }
    });
  }

  function toggleNotDown(btn, pid) {
    const e = sheet.draft.result.entries[pid];
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

  function saveRound() {
    const { i, draft, isEdit } = sheet;
    const err = R.validateResult(state.current, draft.result);
    if (err) { document.getElementById('sheet-error').textContent = err; return; }
    closeSheet();
    changeCurrent((game) => {
      game.rounds[i].adds = draft.adds;
      R.setResult(game, i, draft.result);
    });
    if (isEdit) { toast('משחק ' + (i + 1) + ' עודכן'); return; }
    const next = R.currentIndex(state.current);
    toast(`משחק ${next + 1}: ${R.dealer(state.current, next).name} מחלק`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- finishing the evening ----------
  async function finishGame(opts) {
    opts = opts || {};
    const g = state.current;
    if (!R.playedCount(g)) {
      if (await confirmDiscard()) goHome();
      return null;
    }
    const cur = R.currentIndex(g);
    if (cur >= 0 && R.hasAdds(g.rounds[cur])) {
      const choice = await ask({
        title: `משחק ${cur + 1} עוד לא נגמר`,
        body: 'נרשמו בו נקודות. אם הערב יסתיים עכשיו, המשחק הזה לא ייספר.',
        buttons: [
          { label: 'קודם אסיים את המשחק', value: 'round', kind: 'primary' },
          { label: 'סיים את הערב בלי המשחק הזה', value: 'drop' },
          { label: 'ביטול', value: null }
        ],
        cancel: null
      });
      if (!choice) return null;
      if (choice === 'round') {
        if (view.name !== 'game') go('game');
        openRound(cur);
        return null;
      }
    } else {
      const lead = R.ranking(g)[0];
      const ok = await ask({
        title: 'לסיים את הערב?',
        body: `${playedText(R.playedCount(g))}. מוביל: ${esc(lead.player.name)} עם <span class="num">${lead.total}</span> נקודות.`,
        buttons: [{ label: 'סיים ושמור', value: true, kind: 'primary' }, { label: 'ביטול', value: false }]
      });
      if (!ok) return null;
    }
    const lead = R.leaders(g);
    let winnerId = lead[0].id;
    if (lead.length > 1) {
      winnerId = await ask({
        title: 'תיקו בראש הטבלה',
        body: esc(lead.map((p) => p.name).join(' ו')) + ' סיימו עם אותו ניקוד. מי המנצח?',
        buttons: lead.map((p) => ({ label: p.name, value: p.id, kind: 'primary' })).concat([{ label: 'ביטול', value: null }]),
        cancel: null
      });
      if (!winnerId) return null;
    }
    R.finishGame(g, winnerId);
    state.history.push(g);
    state.current = null;
    state.lastPlayers = names(g);
    if (g.tournamentId) state.lastTournamentId = g.tournamentId;
    state.sync.unsyncedGames.push(g.id);
    state.sync.currentVersion++;
    undoStack = [];
    persist();
    scheduleSync(0);
    if (opts.show !== false) {
      stack = [{ name: 'home' }];
      replace('game-detail', { id: g.id, justFinished: true });
    }
    return g;
  }

  // ---------- history ----------
  // Tournament picker for history and reports; hidden while there is only one tournament.
  function tourFilter(games) {
    const ids = new Set(games.map((g) => g.tournamentId));
    const list = T.live(state.tournaments).filter((t) => ids.has(t.id));
    if (list.length < 2 && view.tour === 'all') return '';
    return `<select class="tour-filter" data-field="tour" aria-label="טורניר">
      <option value="all">כל הטורנירים</option>
      ${list.map((t) => `<option value="${t.id}"${view.tour === t.id ? ' selected' : ''}>${esc(t.name)}${t.archived ? ' (בארכיון)' : ''}</option>`).join('')}
    </select>`;
  }

  function validTour(id) {
    const t = T.find(state.tournaments, id);
    return t && !t.deleted ? id : 'all';
  }

  VIEWS.history = () => {
    const all = ST.finished(state.history);
    if (!all.length) return '<p class="empty">עוד אין ערבים שמורים.<br>כל ערב שמסתיים יופיע כאן.</p>';
    view.tour = validTour(view.tour);
    const list = ST.filterByTournament(all, view.tour).reverse();
    const showTour = view.tour === 'all' && new Set(all.map((g) => g.tournamentId)).size > 1;
    return `<h2>היסטוריה <span class="muted">(${list.length})</span></h2>` + tourFilter(all) + '<ul class="list">' + list.map((g) => {
      const rank = R.ranking(g);
      return `
        <li><button class="card" data-act="view-game" data-id="${g.id}">
          <div class="hist-top"><span>${fmtDate(g.finishedAt, true)}</span><span>${gamesText(g.rounds.length)}</span></div>
          <div class="hist-winner">🏆 ${esc(rank[0].player.name)} <span class="num">${rank[0].total}</span></div>
          <div class="muted">${rank.slice(1).map((r) => `${esc(r.player.name)} <span class="num">${r.total}</span>`).join(' · ')}</div>
          ${showTour ? `<div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>` : ''}
        </button></li>`;
    }).join('') + '</ul>';
  };

  VIEWS['game-detail'] = () => {
    const g = findGame(view.id);
    if (!g) return '<p class="empty">הערב לא נמצא.</p>';
    const winner = R.ranking(g)[0].player.name;
    let h = `
      <section class="card">
        <div class="label">${view.justFinished ? 'הערב הסתיים 🎉' : fmtDate(g.finishedAt, true)}</div>
        <div class="winner-name">🏆 ${esc(winner)}</div>
        <div class="muted">${gamesText(g.rounds.length)}</div>
        <div class="muted tour-line">טורניר: ${esc(tourName(g))}</div>
        ${rankList(g, true)}
      </section>`;
    h += scoreTableHtml(g, false);
    if (view.justFinished) {
      h += `<button class="btn primary big" data-act="rematch" data-id="${g.id}">ערב חדש עם אותם שחקנים</button>
        <div class="row"><button class="btn" data-act="home">למסך הראשי</button></div>`;
    }
    h += `<button class="btn block" data-act="move-game" data-id="${g.id}">העבר לטורניר אחר</button>
      <button class="btn block danger" data-act="delete-game" data-id="${g.id}">מחק את הערב מההיסטוריה</button>`;
    return h;
  };

  async function moveGame(id) {
    const g = findGame(id);
    if (!g) return;
    const others = T.live(state.tournaments).filter((t) => !t.archived && t.id !== g.tournamentId);
    if (!others.length) { toast('אין טורניר אחר. אפשר לפתוח אחד במסך "טורנירים".'); return; }
    const to = await ask({
      title: 'להעביר לאיזה טורניר?',
      body: 'הערב עובר עם כל התוצאות, והדוחות של שני הטורנירים מתעדכנים.',
      buttons: others.map((t) => ({ label: t.name, value: t.id })).concat([{ label: 'ביטול', value: null }]),
      cancel: null
    });
    if (!to) return;
    const t = T.find(state.tournaments, to);
    g.tournamentId = t.id;
    g.tournamentName = t.name;
    R.touch(g);
    if (!state.sync.unsyncedGames.includes(g.id)) state.sync.unsyncedGames.push(g.id);
    persist();
    scheduleSync(0);
    render();
    toast('הערב הועבר לטורניר ' + t.name);
  }

  async function deleteGame(id) {
    const g = findGame(id);
    if (!g) return;
    const ok = await ask({
      title: 'למחוק את הערב?',
      body: 'הערב יימחק מההיסטוריה ומהדוחות' + (gh ? ' וגם מגיט' : '') + '.',
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    state.history = state.history.filter((x) => x.id !== id);
    const u = state.sync.unsyncedGames.indexOf(id);
    if (u >= 0) state.sync.unsyncedGames.splice(u, 1);
    else state.sync.deletedGames.push(SY.gamePath(g));
    persist();
    scheduleSync(0);
    toast('הערב נמחק');
    back();
  }

  // ---------- reports ----------
  const PERIODS = [['all', 'הכול'], ['year', 'השנה'], ['30d', '30 יום']];
  const TABS = [['winners', 'מנצחים'], ['points', 'נקודות'], ['players', 'שחקנים'], ['general', 'כללי'], ['h2h', 'ראש בראש'], ['tours', 'טורנירים']];

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

  const REPORTS = {
    winners(sum, games) {
      const last = ST.lastGame(games);
      let h = last ? lastWinnerCard(last) : '';
      h += `<section class="card"><h3>טבלת מנצחים</h3><div class="table-scroll"><table class="data">
        <thead><tr><th>#</th><th>שחקן</th><th>ניצחונות</th><th>ערבים</th><th>אחוז</th><th>נקודות</th></tr></thead><tbody>`;
      sum.players.forEach((s, i) => {
        h += `<tr${i === 0 && s.wins ? ' class="top1"' : ''}><td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.wins}</td><td>${s.games}</td><td>${pct(s.winPct)}</td><td class="num">${s.totalPoints}</td></tr>`;
      });
      h += '</tbody></table></div><p class="muted" style="margin-top:8px">הדירוג לפי ניצחונות בערבים. בשוויון, מי שצבר יותר נקודות.</p></section>';
      h += '<section class="card"><h3>ניצחונות בערבים</h3>' +
        barChart(sum.players.map((s) => ({ label: s.name, value: s.wins, text: String(s.wins) }))) + '</section>';
      return h;
    },

    points(sum) {
      const list = sum.players.slice().sort((a, b) => b.avgPoints - a.avgPoints);
      let h = `<section class="card"><h3>כלל הנקודות</h3><div class="table-scroll"><table class="data">
        <thead><tr><th>#</th><th>שחקן</th><th>סה״כ</th><th>ממוצע לערב</th><th>הערב הטוב</th><th>הערב הגרוע</th></tr></thead><tbody>`;
      list.forEach((s, i) => {
        h += `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td class="num">${s.totalPoints}</td><td class="num">${Math.round(s.avgPoints)}</td><td class="num">${s.best}</td><td class="num">${s.worst}</td></tr>`;
      });
      h += '</tbody></table></div><p class="muted" style="margin-top:8px">ברמי קומבינציות יותר נקודות זה טוב יותר.</p></section>';
      h += '<section class="card"><h3>ממוצע נקודות לערב</h3>' +
        barChart(list.map((s) => ({ label: s.name, value: Math.round(s.avgPoints), text: String(Math.round(s.avgPoints)) }))) + '</section>';
      return h;
    },

    players(sum) {
      const n = (x) => `<span class="num">${x}</span>`;
      return sum.players.map((s) => `
        <section class="card">
          <h3>${esc(s.name)} <span class="muted">· ${eveningsText(s.games)}</span></h3>
          <ul class="stat-list">
            ${li('ניצחונות בערבים', `${s.wins} (${pct(s.winPct)})`)}
            ${li('רצף ניצחונות שיא', s.longestStreak)}
            ${li('רצף ניצחונות נוכחי', s.currentStreak)}
            ${li('משחקים שניצח', `${s.closes} מתוך ${s.roundsPlayed} (${pct(s.closePct)})`)}
            ${li(`פעמים שלא ירד (${minus(R.NOT_DOWN_POINTS)})`, s.notDowns)}
            ${li('ממוצע נקודות למשחק', n(round1(s.avgRound)))}
            ${li('המשחק הכי טוב', n(s.bestRound))}
            ${li('נקודות שצבר במהלך המשחקים', n(s.scored))}
            ${li('נקודות שירדו בסוף משחק', n(s.lost ? '-' + s.lost : 0))}
            ${li('מקום ממוצע', round1(s.avgPlace))}
          </ul>
        </section>`).join('');
    },

    general(sum) {
      const g = sum.general;
      return `
        <section class="card"><ul class="stat-list">
          ${li('ערבים', g.games)}
          ${li('משחקים', g.rounds)}
          ${li('ממוצע משחקים לערב', round1(g.games ? g.rounds / g.games : 0))}
          ${li(`פעמים שמישהו לא ירד (${minus(R.NOT_DOWN_POINTS)})`, g.notDowns)}
          ${g.mostWins ? li('הכי הרבה ניצחונות בערבים', `${esc(g.mostWins.name)} (${g.mostWins.wins})`) : ''}
          ${g.mostCloses ? li('הכי הרבה ניצחונות במשחקים', `${esc(g.mostCloses.name)} (${g.mostCloses.closes})`) : ''}
          ${g.longestStreak ? li('רצף הניצחונות הארוך ביותר', `${esc(g.longestStreak.name)} (${g.longestStreak.length} ברצף)`) : ''}
          ${g.bestRound ? li('המשחק הכי טוב', `${esc(g.bestRound.name)}: <span class="num">${g.bestRound.points}</span> נק׳ (${fmtDate(g.bestRound.date)}, משחק ${g.bestRound.round})`) : ''}
          ${g.bestGame ? li('הערב הכי טוב', `${esc(g.bestGame.name)}: <span class="num">${g.bestGame.points}</span> נק׳ (${fmtDate(g.bestGame.date)})`) : ''}
        </ul></section>`;
    },

    h2h(sum, games) {
      const ns = ST.playerNames(games);
      if (ns.length < 2) return '<p class="empty">צריך לפחות שני שחקנים.</p>';
      const a = ns.includes(view.h2hA) ? view.h2hA : ns[0];
      const b = ns.includes(view.h2hB) && view.h2hB !== a ? view.h2hB : ns.find((n) => n !== a);
      const opts = (sel) => ns.map((n) => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const r = ST.headToHead(games, a, b);
      let h = `
        <section class="card form">
          <div class="h2h">
            <select data-field="h2hA" aria-label="שחקן ראשון">${opts(a)}</select>
            <b style="padding-bottom:12px">נגד</b>
            <select data-field="h2hB" aria-label="שחקן שני">${opts(b)}</select>
          </div>`;
      if (!r.together) {
        h += '<p class="empty">השניים לא שיחקו יחד בתקופה הזו.</p>';
      } else {
        h += `
          <div class="h2h-score">
            <div><div class="big">${r.a}</div>${esc(a)}</div>
            <div class="muted">${eveningsText(r.together)} יחד</div>
            <div><div class="big">${r.b}</div>${esc(b)}</div>
          </div>
          <p class="muted" style="text-align:center">כמה פעמים כל אחד סיים עם יותר נקודות מהשני${r.even ? ` · שוויון: ${r.even}` : ''}</p>`;
      }
      return h + '</section>';
    }
  };

  // Every tournament with games in the period; a row opens that tournament's reports.
  function toursReport(games) {
    const rows = T.overview(state.tournaments, games).filter((r) => r.games);
    if (!rows.length) return '<p class="empty">אין ערבים בתקופה הזו.</p>';
    return `<section class="card"><h3>כל הטורנירים</h3><div class="table-scroll"><table class="data tours">
      <thead><tr><th>טורניר</th><th>ערבים</th><th>אחרון</th><th>מוביל</th></tr></thead><tbody>` +
      rows.map((r) => `
        <tr data-act="pick-tour" data-id="${r.tournament.id}"${view.tour === r.tournament.id ? ' class="top1"' : ''}>
          <td>${esc(r.tournament.name)}${r.tournament.archived ? ' <span class="muted">(בארכיון)</span>' : ''}</td>
          <td>${r.games}</td><td>${fmtDate(r.lastAt)}</td>
          <td>${esc(r.leader.name)} <span class="muted">(${winsText(r.leader.wins)})</span></td>
        </tr>`).join('') +
      '</tbody></table></div><p class="muted" style="margin-top:8px">המוביל הוא מי שניצח בהכי הרבה ערבים. בשוויון, מי שצבר יותר נקודות. לחיצה על טורניר מציגה את הדוחות שלו.</p></section>';
  }

  VIEWS.reports = () => {
    view.period = view.period || 'all';
    view.tab = view.tab || 'winners';
    const all = ST.finished(state.history);
    if (!all.length) return '<p class="empty">הדוחות יופיעו אחרי שתסיימו ותשמרו את הערב הראשון.</p>';
    view.tour = validTour(view.tour);
    let h = backupNag();
    h += tourFilter(all);
    h += '<div class="seg">' + PERIODS.map(([v, label]) => `<button class="chip${view.period === v ? ' on' : ''}" data-act="period" data-v="${v}">${label}</button>`).join('') + '</div>';
    h += '<div class="tabs" role="tablist">' + TABS.map(([v, label]) => `<button class="tab${view.tab === v ? ' on' : ''}" role="tab" aria-selected="${view.tab === v}" data-act="tab" data-v="${v}">${label}</button>`).join('') + '</div>';
    if (view.tab === 'tours') return h + toursReport(ST.filterByPeriod(all, view.period));
    const games = ST.filterByPeriod(ST.filterByTournament(all, view.tour), view.period);
    if (!games.length) return h + '<p class="empty">אין ערבים בתקופה הזו.</p>';
    return h + REPORTS[view.tab](ST.summary(games), games);
  };

  // ---------- tournaments ----------
  VIEWS.tournaments = () => {
    const rows = T.overview(state.tournaments, state.history);
    const inUse = (r) => r.games || (state.current && state.current.tournamentId === r.tournament.id);
    const card = (r) => {
      const t = r.tournament;
      return `
        <li class="card">
          <div class="hist-top"><b class="tour-title">${esc(t.name)}</b><span>${r.games ? eveningsText(r.games) : 'עוד אין ערבים'}</span></div>
          ${r.leader ? `<div class="muted">מוביל: ${esc(r.leader.name)} (${winsText(r.leader.wins)}) · אחרון: ${fmtDate(r.lastAt)}</div>` : ''}
          <div class="tour-actions">
            ${r.games ? `<button class="btn sm" data-act="tour-reports" data-id="${t.id}">דוחות</button>` : ''}
            <button class="btn sm" data-act="tour-rename" data-id="${t.id}">שנה שם</button>
            <button class="btn sm" data-act="tour-archive" data-id="${t.id}">${t.archived ? 'החזר מהארכיון' : 'לארכיון'}</button>
            ${inUse(r) ? '' : `<button class="btn sm danger" data-act="tour-delete" data-id="${t.id}">מחק</button>`}
          </div>
        </li>`;
    };
    const open = rows.filter((r) => !r.tournament.archived);
    const archived = rows.filter((r) => r.tournament.archived);
    let h = `<h2>טורנירים</h2>
      <p class="muted">כל הרכב שחקנים מקבל טורניר משלו אוטומטית. כדי להפריד, למשל לפי מקום, פותחים טורניר חדש ובוחרים אותו כשמתחילים ערב.</p>
      <button class="btn block" data-act="tour-new">+ טורניר חדש</button>
      <div style="height:12px"></div>`;
    h += open.length ? `<ul class="list">${open.map(card).join('')}</ul>` : '<p class="empty">עוד אין טורנירים. טורניר נפתח כשמתחילים ערב.</p>';
    if (archived.length) {
      h += `<h2>בארכיון</h2><p class="muted">הם לא מוצעים כשמתחילים ערב, אבל נשארים בדוחות ובהיסטוריה.</p><ul class="list">${archived.map(card).join('')}</ul>`;
    }
    return h;
  };

  const nameTaken = (name, except) => {
    const t = T.findByName(state.tournaments, name);
    return t && t !== except ? 'כבר יש טורניר בשם הזה' : '';
  };

  function tournamentsSaved() {
    toursChanged();
    persist();
    scheduleSync();
    render();
  }

  async function newTournament() {
    const name = await askText({ title: 'טורניר חדש', placeholder: 'למשל: אצל סבתא', okLabel: 'פתח טורניר', validate: (v) => nameTaken(v) });
    if (!name) return;
    state.tournaments.push(T.make(name, null));
    tournamentsSaved();
    toast('הטורניר נפתח. בוחרים אותו כשמתחילים ערב.');
  }

  async function renameTournament(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    const name = await askText({ title: 'שם הטורניר', value: t.name, validate: (v) => nameTaken(v, t) });
    if (!name || name === t.name) return;
    t.name = name;
    T.touch(t);
    tournamentsSaved();
  }

  function toggleArchive(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    t.archived = !t.archived;
    T.touch(t);
    tournamentsSaved();
    toast(t.archived ? 'הטורניר הועבר לארכיון' : 'הטורניר חזר מהארכיון');
  }

  async function deleteTournament(id) {
    const t = T.find(state.tournaments, id);
    if (!t) return;
    if (T.gamesOf(state.history, id).length || (state.current && state.current.tournamentId === id)) {
      toast('אפשר למחוק רק טורניר בלי ערבים');
      return;
    }
    const ok = await ask({
      title: `למחוק את הטורניר "${t.name}"?`,
      buttons: [{ label: 'מחק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    t.deleted = true;
    T.touch(t);
    if (state.lastTournamentId === id) state.lastTournamentId = null;
    tournamentsSaved();
  }

  function tourReports(id) {
    if (view.name === 'reports') {
      view.tour = id;
      view.tab = 'winners';
      render();
      window.scrollTo(0, 0);
    } else {
      go('reports', { tour: id, tab: 'winners' });
    }
  }

  // ---------- settings: git + backup ----------
  VIEWS.settings = () => {
    let h = `<section class="card form"><h2>שמירה בגיט</h2>
      <p class="muted">כל ערב שמסתיים, וגם הערב הפתוח אחרי כל שינוי, נשמרים כקבצים במאגר גיטהאב שלך. כך שום דבר לא הולך לאיבוד, ואפשר להמשיך גם מטלפון אחר.</p>`;
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
    h += `</section>
      <section class="card"><h2>גיבוי לקובץ</h2>
        <p class="muted">קובץ אחד עם כל הערבים. אפשר לשלוח אותו לעצמך ולטעון אותו בטלפון אחר.</p>
        <div class="row">
          <button class="btn" data-act="export">ייצוא גיבוי</button>
          <label class="btn">ייבוא גיבוי<input type="file" id="import-file" accept=".json,application/json" hidden></label>
        </div>
      </section>
      <section class="card"><h2>במכשיר הזה</h2>
        <ul class="stat-list">
          ${li('ערבים שמורים', state.history.length)}
          ${li('טורנירים', T.live(state.tournaments).length)}
          ${li('ערב פתוח', state.current ? 'כן' : 'לא')}
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
      body: 'הערבים יישארו בטלפון ובמאגר, אבל ערבים חדשים לא יישמרו בגיט עד שתתחבר שוב.',
      buttons: [{ label: 'נתק', value: true, kind: 'danger' }, { label: 'ביטול', value: false }]
    });
    if (!ok) return;
    saveGh(null);
    render();
  }

  async function exportBackup() {
    const data = { app: 'rummycombos', version: 1, exportedAt: new Date().toISOString(), history: state.history, current: state.current, tournaments: state.tournaments };
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
    state.backupCount = state.history.length;
    persist();
    toast('קובץ הגיבוי נוצר');
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('הקובץ לא תקין'); return; }
      if (!data || !Array.isArray(data.history)) { toast('זה לא קובץ גיבוי של רמי קומבינציות'); return; }
      const before = new Set(state.history.map((g) => g.id));
      const merged = ST.mergeHistory(state.history, data.history);
      state.history = merged.games;
      state.history.forEach(R.normalize);
      state.history.forEach((g) => {
        if (!before.has(g.id) && !state.sync.unsyncedGames.includes(g.id)) state.sync.unsyncedGames.push(g.id);
      });
      const mt = T.merge(state.tournaments, data.tournaments || []);
      state.tournaments = mt.list;
      if (mt.changed) toursChanged();
      fixTournaments();
      persist();
      if (data.current && !data.current.finishedAt && !state.current) {
        const load = await ask({
          title: 'בקובץ יש ערב פתוח',
          body: 'לטעון אותו ולהמשיך לשחק?',
          buttons: [{ label: 'טען', value: true, kind: 'primary' }, { label: 'לא', value: false }]
        });
        if (load) {
          state.current = R.normalize(data.current);
          undoStack = [];
          state.sync.currentVersion++;
          fixTournaments();
          persist();
        }
      }
      scheduleSync(0);
      toast(merged.added ? 'נוספו ' + eveningsText(merged.added) : 'כל הערבים בקובץ כבר קיימים');
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
      case 'new-game': newGame(); break;
      case 'pick-dealer': view.firstDealer = +d.i; render(); break;
      case 'move': movePlayer(+d.i, +d.d); break;
      case 'remove-player': removePlayer(+d.i); break;
      case 'add-player': view.names.push(''); render(); document.querySelector(`.pname[data-i="${view.names.length - 1}"]`).focus(); break;
      case 'start-game': startGame(); break;
      case 'open-round': openRound(+d.i); break;
      case 'close-sheet': closeSheet(); break;
      case 'pick-closer': pickCloser(d.id); break;
      case 'toggle-notdown': toggleNotDown(el, d.id); break;
      case 'save-round': saveRound(); break;
      case 'add-points': addPointsFor(d.pid); break;
      case 'edit-add': editAdd(d.pid, +d.k); break;
      case 'sheet-add': sheetAdd(d.pid); break;
      case 'sheet-edit-add': sheetEditAdd(d.pid, +d.k); break;
      case 'pad-key': padKey(d.k); break;
      case 'pad-ok': padOk(); break;
      case 'pad-delete': padDelete(); break;
      case 'pad-cancel': padCancel(); break;
      case 'undo': undo(); break;
      case 'finish': finishGame(); break;
      case 'discard': confirmDiscard().then((ok) => { if (ok) goHome(); }); break;
      case 'view-game': go('game-detail', { id: d.id }); break;
      case 'rematch': startSetup(names(findGame(d.id)), findGame(d.id).tournamentId); break;
      case 'delete-game': deleteGame(d.id); break;
      case 'move-game': moveGame(d.id); break;
      case 'pick-tour': tourReports(d.id); break;
      case 'tour-reports': tourReports(d.id); break;
      case 'tour-new': newTournament(); break;
      case 'tour-rename': renameTournament(d.id); break;
      case 'tour-archive': toggleArchive(d.id); break;
      case 'tour-delete': deleteTournament(d.id); break;
      case 'period': view.period = d.v; render(); break;
      case 'tab': view.tab = d.v; render(); break;
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
      autoTournament(view);
      refreshTourPick();
    } else if (t.id === 'tour-name') {
      view.tourName = t.value;
      view.tourNameEdited = true;
    } else if (t.classList.contains('pts') && sheet) {
      t.value = t.value.replace(/\D/g, '');
      const entry = sheet.draft.result.entries[t.dataset.pid];
      entry.points = t.value;
      entry.auto = false;
      document.getElementById('sheet-error').textContent = '';
      updateSheetPreview();
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    const field = t.dataset.field;
    if (field === 'h2hA' || field === 'h2hB') { view[field] = t.value; render(); }
    else if (field === 'tour') { view.tour = t.value; render(); }
    else if (field === 'tourSel') {
      view.tourSel = t.value;
      view.tourManual = true;
      refreshTourPick();
      const input = document.getElementById('tour-name');
      if (input) { input.focus(); input.select(); }
    }
    else if (t.id === 'import-file' && t.files && t.files[0]) { importBackup(t.files[0]); t.value = ''; }
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
    const cls = t.classList.contains('pts') ? '.pts' : t.classList.contains('pname') ? '.pname' : null;
    if (!cls) return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll(cls + ':not(:disabled)'));
    const next = all[all.indexOf(t) + 1];
    if (next) next.focus();
    else t.blur();
  });

  // ---------- start ----------
  if (fixTournaments()) persist();
  if (state.current) {
    stack = [{ name: 'home' }];
    view = { name: 'game' };
    history.pushState({ rummy: 1 }, '');
  }
  render();
  if (gh) pullFromGit(true);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
