/* Rummy Combos — keeping copies of a tournament in step (two phones, git, a backup file),
   and converting what the first version saved (evenings made of rounds). Pure functions, no DOM.
   A deleted tournament stays as a tombstone ({ id, name, deleted: true }) so the deletion reaches other phones. */
(function (root) {
  'use strict';

  var R = root.Rummy;

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function defaultName(names) {
    return names.map(R.cleanName).filter(Boolean).join(' · ');
  }

  function live(list) {
    return list.filter(function (t) { return !t.deleted; });
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findByName(list, name) {
    var key = R.cleanName(name).toLowerCase();
    var hits = live(list).filter(function (t) { return t.name.toLowerCase() === key; });
    return hits.length ? hits[0] : null;
  }

  function tombstone(t) {
    var at = R.now();
    return { id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: at, metaAt: at, deleted: true, players: [], games: [] };
  }

  function metaSig(t) {
    return JSON.stringify([t.name, !!t.deleted, t.finishedAt || '', t.winnerIds || []]);
  }

  function gameSig(g) {
    var r = g.result;
    var hands = r && r.hands ? Object.keys(r.hands).sort().map(function (k) { return [k, r.hands[k].points, !!r.hands[k].notDown]; }) : null;
    return [g.id, g.updatedAt || '', g.finishedAt || '', (g.points || []).map(function (e) { return [e.pid, e.n]; }), r ? [r.winnerId, hands] : null];
  }

  // What two copies are compared by (content, not key order).
  function sig(t) {
    return JSON.stringify([
      t.metaAt || '', metaSig(t),
      (t.players || []).map(function (p) { return [p.id, p.name, p.at || '']; }),
      (t.games || []).map(gameSig)
    ]);
  }

  // How far along a copy is: a finished game, then more entries.
  function progress(o) {
    return (o.result ? 1e6 : 0) + (Array.isArray(o.points) ? o.points.length : 0);
  }

  // Whether copy x should replace copy have: the later stamp wins. With equal stamps (two changes in the
  // same millisecond) the copy further along wins, and otherwise a fixed order, so every phone picks the same one.
  function wins(x, have, stamp) {
    var a = x[stamp] || '', b = have[stamp] || '';
    if (a !== b) return a > b;
    var sx = JSON.stringify(x), sh = JSON.stringify(have);
    if (sx === sh) return false;
    if (progress(x) !== progress(have)) return progress(x) > progress(have);
    return sx > sh;
  }

  // Union by id; see wins() for which copy is kept.
  function unionById(a, b, stamp) {
    var map = {};
    var order = [];
    a.concat(b).forEach(function (x) {
      var have = map[x.id];
      if (!have) { map[x.id] = x; order.push(x.id); }
      else if (wins(x, have, stamp)) map[x.id] = x;
    });
    return order.map(function (id) { return clone(map[id]); });
  }

  // Two copies of one tournament. The name, the players' names and the finished state come from the copy
  // whose metaAt is later; each game comes from the copy that changed it last.
  // changed = the result differs from local; ahead = it differs from remote (it should be uploaded).
  function mergeTournament(local, remote) {
    if (!local) return { tournament: R.normalize(clone(remote)), changed: true, ahead: false };
    if (!remote) return { tournament: local, changed: false, ahead: true };
    var lm = local.metaAt || '', rm = remote.metaAt || '';
    var meta = rm > lm || (rm === lm && metaSig(remote) > metaSig(local)) ? remote : local;
    var out = {
      id: local.id,
      name: meta.name,
      createdAt: [local.createdAt, remote.createdAt].filter(Boolean).sort()[0],
      updatedAt: [local.updatedAt || '', remote.updatedAt || ''].sort()[1],
      metaAt: meta.metaAt
    };
    if (meta.deleted) {
      out.deleted = true;
      out.players = [];
      out.games = [];
    } else {
      if (meta.finishedAt) {
        out.finishedAt = meta.finishedAt;
        out.winnerIds = (meta.winnerIds || []).slice();
      }
      out.players = unionById(local.players || [], remote.players || [], 'at');
      out.games = unionById(local.games || [], remote.games || [], 'updatedAt');
      R.normalize(out);
    }
    var s = sig(out);
    return { tournament: out, changed: s !== sig(local), ahead: s !== sig(remote) };
  }

  // Merges a list (e.g. from a backup file) into the local one. Returns the new list and the ids that changed.
  function mergeLists(local, incoming) {
    var list = local.slice();
    var changed = [];
    var added = 0;
    (incoming || []).forEach(function (t) {
      if (!t || !t.id) return;
      var i = list.findIndex(function (x) { return x.id === t.id; });
      var m = mergeTournament(i >= 0 ? list[i] : null, t);
      if (!m.changed) return;
      if (i >= 0) list[i] = m.tournament;
      else { list.push(m.tournament); if (!t.deleted) added++; }
      changed.push(t.id);
    });
    return { list: list, changed: changed, added: added };
  }

  // ---------- data saved by the first version ----------
  // A stable short id, so converting the same data on two phones gives the same ids.
  function hashId(prefix, s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return prefix + h.toString(36);
  }

  // First version: { history: [evening], current: evening|null, tournaments: [{ id, name, archived }] },
  // evening = { id, tournamentId, players, rounds: [{ adds: { pid: [n] }, result: { closerId, entries } }] }.
  // Every round becomes a game of the evening's tournament; evenings disappear.
  function fromV1(old) {
    var evenings = (old.history || []).filter(function (e) { return e && Array.isArray(e.rounds) && Array.isArray(e.players); });
    if (old.current && Array.isArray(old.current.rounds) && Array.isArray(old.current.players)) evenings.push(old.current);
    evenings.sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    var oldTours = {};
    (old.tournaments || []).forEach(function (t) { if (t && t.id) oldTours[t.id] = t; });

    var groups = {};
    var order = [];
    evenings.forEach(function (ev) {
      var names = ev.players.map(function (p) { return R.cleanName(p.name); });
      var key = ev.tournamentId || hashId('l', names.slice().sort().join('|'));
      if (!groups[key]) { groups[key] = { evenings: [], name: ev.tournamentName || defaultName(names) }; order.push(key); }
      groups[key].evenings.push(ev);
    });
    // Tournaments that were opened but never played in.
    Object.keys(oldTours).forEach(function (id) {
      if (!groups[id] && !oldTours[id].deleted) { groups[id] = { evenings: [], name: oldTours[id].name }; order.push(id); }
    });

    return order.map(function (key) {
      var grp = groups[key];
      var ot = oldTours[key];
      var at = (ot && ot.createdAt) || (grp.evenings[0] && grp.evenings[0].createdAt) || R.now();
      var tour = { id: key, name: (ot && ot.name) || grp.name, createdAt: at, updatedAt: at, metaAt: at, players: [], games: [] };
      var pidByName = {};
      grp.evenings.forEach(function (ev) {
        var map = {};
        ev.players.forEach(function (p) {
          var name = R.cleanName(p.name);
          if (!pidByName[name]) {
            pidByName[name] = hashId('n', name);
            tour.players.push({ id: pidByName[name], name: name, at: at });
          }
          map[p.id] = pidByName[name];
        });
        var start = Date.parse(ev.createdAt || at) || Date.now();
        ev.rounds.forEach(function (r, i) {
          var points = [];
          Object.keys(r.adds || {}).forEach(function (oldPid) {
            (r.adds[oldPid] || []).forEach(function (n) { if (map[oldPid] && Number(n)) points.push({ pid: map[oldPid], n: Number(n) }); });
          });
          var res = r.result;
          if (!res && (ev.finishedAt || !points.length)) return;
          var created = new Date(start + i).toISOString();
          var g = { id: ev.id + '-' + (i + 1), createdAt: created, updatedAt: ev.updatedAt || created, points: points, result: null };
          if (res && map[res.closerId]) {
            var hands = {};
            Object.keys(res.entries || {}).forEach(function (oldPid) {
              var e = res.entries[oldPid];
              if (map[oldPid] && e) hands[map[oldPid]] = { points: e.notDown ? 0 : Math.round(Number(e.points) || 0), notDown: !!e.notDown };
            });
            g.result = { winnerId: map[res.closerId], hands: hands };
            g.finishedAt = ev.finishedAt || ev.updatedAt || created;
          }
          tour.games.push(g);
          if ((g.updatedAt || '') > tour.updatedAt) tour.updatedAt = g.updatedAt;
        });
      });
      R.normalize(tour);
      if (ot && ot.archived && R.finishedGames(tour).length) {
        R.dropOpenGame(tour);
        tour.winnerIds = R.tournamentWinners(tour);
        tour.finishedAt = tour.updatedAt;
      }
      return tour;
    });
  }

  var RummyTournaments = {
    defaultName: defaultName,
    live: live,
    find: find,
    findByName: findByName,
    tombstone: tombstone,
    sig: sig,
    mergeTournament: mergeTournament,
    mergeLists: mergeLists,
    fromV1: fromV1
  };

  root.RummyTournaments = RummyTournaments;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyTournaments;
})(typeof window !== 'undefined' ? window : globalThis);
