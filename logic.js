/* Rummy Combos — game rules. Pure functions, no DOM.
   A tournament has players and games. A game is one hand: players add points during the game,
   and when it ends everyone but the winner loses the cards left in hand (70 if they never went down).
   Tournament = { id, name, createdAt, updatedAt, metaAt, players: [{ id, name, at }], games: [Game],
                  finishedAt?, winnerIds?, deleted? }
   Game = { id, createdAt, updatedAt, finishedAt?, dealerId?, points: [{ pid, n }],
            result: null | { winnerId, hands: { pid: { points, notDown } } } }
   points keeps the order of entry; n < 0 takes points off (a mistake taken back, or a penalty).
   dealerId = who deals the game; the next game is dealt by the next participant in seat order.
   Scores are never stored: they are always recomputed from what was entered.
   metaAt = when the name, players or finished state last changed (used when merging copies). */
(function (root) {
  'use strict';

  var NOT_DOWN_POINTS = 70;
  var MAX_POINTS = 9999;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function now() {
    return new Date().toISOString();
  }

  function cleanName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // ---------- tournament ----------
  function newGame(at) {
    var t = at || now();
    return { id: uid(), createdAt: t, updatedAt: t, points: [], result: null };
  }

  function newPlayer(name, at) {
    return { id: uid(), name: cleanName(name), at: at || now() };
  }

  // firstDealer = the seat of the participant who deals the first game (default: the first one).
  function newTournament(name, names, firstDealer) {
    var t = now();
    var tour = { id: uid(), name: cleanName(name), createdAt: t, updatedAt: t, metaAt: t, players: [], games: [] };
    names.forEach(function (n) { tour.players.push(newPlayer(n, t)); });
    var g = newGame(t);
    var first = tour.players[Math.max(0, Number(firstDealer) || 0) % (tour.players.length || 1)];
    if (first) g.dealerId = first.id;
    tour.games.push(g);
    return tour;
  }

  function touch(tour, game) {
    var t = now();
    if (game) game.updatedAt = t;
    tour.updatedAt = t;
  }

  function touchMeta(tour) {
    tour.metaAt = tour.updatedAt = now();
  }

  function playerById(tour, id) {
    for (var i = 0; i < tour.players.length; i++) {
      if (tour.players[i].id === id) return tour.players[i];
    }
    return null;
  }

  function playerByName(tour, name) {
    var key = cleanName(name).toLowerCase();
    for (var i = 0; i < tour.players.length; i++) {
      if (tour.players[i].name.toLowerCase() === key) return tour.players[i];
    }
    return null;
  }

  // A player who joins later starts from 0 and plays from the open game on.
  function addPlayer(tour, name) {
    var p = newPlayer(name);
    tour.players.push(p);
    touchMeta(tour);
    return p;
  }

  function renamePlayer(tour, id, name) {
    var p = playerById(tour, id);
    if (!p) return false;
    p.name = cleanName(name);
    p.at = now();
    touchMeta(tour);
    return true;
  }

  function byCreated(a, b) {
    return (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  // The game being played, or null.
  function currentGame(tour) {
    for (var i = tour.games.length - 1; i >= 0; i--) {
      if (!tour.games[i].result) return tour.games[i];
    }
    return null;
  }

  function finishedGames(tour) {
    return tour.games.filter(function (g) { return g.result; });
  }

  function gameNumber(tour, game) {
    return tour.games.indexOf(game) + 1;
  }

  function findGame(tour, id) {
    for (var i = 0; i < tour.games.length; i++) {
      if (tour.games[i].id === id) return tour.games[i];
    }
    return null;
  }

  function ensureOpenGame(tour) {
    if (tour.finishedAt || tour.deleted || currentGame(tour)) return currentGame(tour);
    var g = newGame();
    var d = dealerOf(tour, g);
    if (d) g.dealerId = d;
    tour.games.push(g);
    return g;
  }

  // ---------- dealer ----------
  function seatOf(tour, pid) {
    for (var i = 0; i < tour.players.length; i++) if (tour.players[i].id === pid) return i;
    return -1;
  }

  // Who deals a game (a player id). A game without a dealer (e.g. a new one) is dealt by the participant
  // after the dealer of the game before it, in seat order.
  function dealerOf(tour, game) {
    var n = tour.players.length;
    if (!n) return null;
    if (game.dealerId && seatOf(tour, game.dealerId) >= 0) return game.dealerId;
    var i = tour.games.indexOf(game);
    if (i < 0) i = tour.games.length;
    for (var j = i - 1; j >= 0; j--) {
      var s = tour.games[j].dealerId ? seatOf(tour, tour.games[j].dealerId) : -1;
      if (s >= 0) return tour.players[(s + i - j) % n].id;
    }
    return tour.players[i % n].id;
  }

  // Changes who deals a game; the games after it go on from the new dealer.
  function setDealer(tour, game, pid) {
    if (seatOf(tour, pid) < 0) return false;
    game.dealerId = pid;
    touch(tour, game);
    return true;
  }

  // Makes a stored tournament safe to use (e.g. one pulled from git or merged from two phones):
  // games in order, at most one open game, and an open game while the tournament is running.
  function normalize(tour) {
    if (!tour) return tour;
    if (!Array.isArray(tour.players)) tour.players = [];
    if (!Array.isArray(tour.games)) tour.games = [];
    tour.metaAt = tour.metaAt || tour.createdAt;
    tour.games.forEach(function (g) {
      if (!Array.isArray(g.points)) g.points = [];
      if (g.result === undefined) g.result = null;
      if (g.result && (!g.result.hands || typeof g.result.hands !== 'object')) g.result.hands = {};
    });
    tour.games.sort(byCreated);
    // Two phones may each have opened a game: keep the one with points, updated last.
    var open = tour.games.filter(function (g) { return !g.result; });
    if (open.length > 1) {
      open.sort(function (a, b) {
        return (b.points.length > 0) - (a.points.length > 0) || (b.updatedAt || '').localeCompare(a.updatedAt || '');
      });
      var keep = open[0];
      tour.games = tour.games.filter(function (g) { return g.result || g === keep; });
    }
    if (tour.finishedAt) tour.games = tour.games.filter(function (g) { return g.result; });
    ensureOpenGame(tour);
    return tour;
  }

  // ---------- points during a game ----------
  function validPoints(n) {
    if (n === '' || n == null) return false;
    n = Number(n);
    return isFinite(n) && n === Math.round(n) && n > 0 && n <= MAX_POINTS;
  }

  // The entries one player made in a game, in order (negative = taken back).
  function entriesOf(game, pid) {
    return game.points.filter(function (e) { return e.pid === pid; }).map(function (e) { return e.n; });
  }

  function gamePoints(game, pid) {
    return entriesOf(game, pid).reduce(function (s, n) { return s + n; }, 0);
  }

  function hasPoints(game) {
    return game.points.length > 0;
  }

  // These work on a game, so they also work on a copy being edited. They return false on bad input.
  function addPoints(game, pid, n) {
    if (!validPoints(n)) return false;
    game.points.push({ pid: pid, n: Number(n) });
    return true;
  }

  // Takes points off a participant (a mistake, or a penalty): any amount, so a game total may go below 0.
  function takePoints(game, pid, n) {
    if (!validPoints(n)) return false;
    game.points.push({ pid: pid, n: -Number(n) });
    return true;
  }

  // Index in game.points of a player's k-th entry.
  function entryIndex(game, pid, k) {
    var seen = -1;
    for (var i = 0; i < game.points.length; i++) {
      if (game.points[i].pid === pid && ++seen === k) return i;
    }
    return -1;
  }

  // A fix keeps the entry's sign.
  function setEntry(game, pid, k, n) {
    var i = entryIndex(game, pid, k);
    if (i < 0 || !validPoints(n)) return false;
    game.points[i].n = game.points[i].n < 0 ? -Number(n) : Number(n);
    return true;
  }

  function removeEntry(game, pid, k) {
    var i = entryIndex(game, pid, k);
    if (i < 0) return false;
    game.points.splice(i, 1);
    return true;
  }

  // The winner is the last player who got points. Points taken off a player first cancel that player's
  // latest points (a mistake taken back), and an entry cancelled in full does not count.
  function lastScorer(game) {
    var left = game.points.map(function (e) { return e.n > 0 ? e.n : 0; });
    game.points.forEach(function (e, i) {
      var take = e.n < 0 ? -e.n : 0;
      for (var j = i - 1; j >= 0 && take > 0; j--) {
        if (game.points[j].pid !== e.pid || left[j] <= 0) continue;
        var c = Math.min(left[j], take);
        left[j] -= c;
        take -= c;
      }
    });
    for (var i = left.length - 1; i >= 0; i--) {
      if (left[i] > 0) return game.points[i].pid;
    }
    return null;
  }

  // A player with no points in the game never went down.
  function suggestNotDown(game, pid) {
    return gamePoints(game, pid) <= 0;
  }

  // ---------- scores ----------
  function handPenalty(hand) {
    if (!hand) return 0;
    return hand.notDown ? NOT_DOWN_POINTS : (Number(hand.points) || 0);
  }

  function playerGameScore(game, result, pid) {
    var scored = gamePoints(game, pid);
    if (pid === result.winnerId) return scored;
    return scored - handPenalty(result.hands && result.hands[pid]);
  }

  // Whether a player took part in a finished game (players who joined later did not).
  function inGame(game, pid) {
    var r = game.result;
    return !!r && (r.winnerId === pid || !!(r.hands && r.hands[pid]) || entriesOf(game, pid).length > 0);
  }

  function gameScores(tour, game) {
    if (!game.result) return null;
    var out = {};
    tour.players.forEach(function (p) { out[p.id] = playerGameScore(game, game.result, p.id); });
    return out;
  }

  // live = also count the points of the game being played, so the standings move during the game.
  function totals(tour, live) {
    var t = {};
    tour.players.forEach(function (p) { t[p.id] = 0; });
    tour.games.forEach(function (g) {
      tour.players.forEach(function (p) {
        if (g.result) t[p.id] += playerGameScore(g, g.result, p.id);
        else if (live) t[p.id] += gamePoints(g, p.id);
      });
    });
    return t;
  }

  function wins(tour) {
    var w = {};
    tour.players.forEach(function (p) { w[p.id] = 0; });
    finishedGames(tour).forEach(function (g) {
      if (w[g.result.winnerId] != null) w[g.result.winnerId]++;
    });
    return w;
  }

  // Highest total first; equal totals share a place. Order inside a tie: more wins, then seat order.
  function standings(tour, live) {
    var t = totals(tour, live);
    var w = wins(tour);
    var rows = tour.players.map(function (p, i) { return { player: p, total: t[p.id], wins: w[p.id], seat: i, place: 0 }; });
    rows.sort(function (a, b) { return b.total - a.total || b.wins - a.wins || a.seat - b.seat; });
    rows.forEach(function (row, i) {
      var prev = rows[i - 1];
      row.place = prev && prev.total === row.total ? prev.place : i + 1;
    });
    return rows;
  }

  // One row per finished game: its scores and the running totals after it.
  function gameTable(tour) {
    var running = {};
    tour.players.forEach(function (p) { running[p.id] = 0; });
    return finishedGames(tour).map(function (g) {
      var s = gameScores(tour, g);
      tour.players.forEach(function (p) { running[p.id] += s[p.id]; });
      return { game: g, number: gameNumber(tour, g), scores: s, totals: Object.assign({}, running) };
    });
  }

  // ---------- end of a game ----------
  // Returns a Hebrew error message, or null when the result is complete.
  function validateResult(tour, result) {
    if (!result || !playerById(tour, result.winnerId)) return 'בחר מי ניצח';
    for (var i = 0; i < tour.players.length; i++) {
      var p = tour.players[i];
      if (p.id === result.winnerId) continue;
      var h = result.hands && result.hands[p.id];
      if (!h || (!h.notDown && !(h.points !== '' && h.points != null && isFinite(h.points) && Number(h.points) >= 0))) {
        return 'כמה נקודות נשארו ביד ל' + p.name + '?';
      }
    }
    return null;
  }

  function normalizeResult(tour, result) {
    var hands = {};
    tour.players.forEach(function (p) {
      if (p.id === result.winnerId) return;
      var h = result.hands[p.id];
      hands[p.id] = h.notDown ? { points: 0, notDown: true } : { points: Math.round(Number(h.points)), notDown: false };
    });
    return { winnerId: result.winnerId, hands: hands };
  }

  // Records how a game ended (also used to fix a finished game). Ending the open game opens the next one.
  function finishGame(tour, game, result, points) {
    if (points) game.points = points;
    game.result = normalizeResult(tour, result);
    if (!game.finishedAt) game.finishedAt = now();
    touch(tour, game);
    ensureOpenGame(tour);
    return game;
  }

  // ---------- end of a tournament ----------
  function dropOpenGame(tour) {
    tour.games = tour.games.filter(function (g) { return g.result; });
  }

  // Most points wins; a tie goes to more wins, and a tie in both is shared.
  function tournamentWinners(tour) {
    var rows = standings(tour, false);
    if (!rows.length || !finishedGames(tour).length) return [];
    var top = rows[0];
    return rows.filter(function (r) { return r.total === top.total && r.wins === top.wins; }).map(function (r) { return r.player.id; });
  }

  function finishTournament(tour) {
    dropOpenGame(tour);
    tour.winnerIds = tournamentWinners(tour);
    tour.finishedAt = now();
    touchMeta(tour);
    return tour;
  }

  function reopenTournament(tour) {
    delete tour.finishedAt;
    delete tour.winnerIds;
    touchMeta(tour);
    ensureOpenGame(tour);
    return tour;
  }

  var Rummy = {
    NOT_DOWN_POINTS: NOT_DOWN_POINTS,
    MAX_POINTS: MAX_POINTS,
    uid: uid,
    now: now,
    cleanName: cleanName,
    newGame: newGame,
    newTournament: newTournament,
    touch: touch,
    touchMeta: touchMeta,
    playerById: playerById,
    playerByName: playerByName,
    addPlayer: addPlayer,
    renamePlayer: renamePlayer,
    currentGame: currentGame,
    finishedGames: finishedGames,
    gameNumber: gameNumber,
    findGame: findGame,
    ensureOpenGame: ensureOpenGame,
    dealerOf: dealerOf,
    setDealer: setDealer,
    normalize: normalize,
    validPoints: validPoints,
    entriesOf: entriesOf,
    gamePoints: gamePoints,
    hasPoints: hasPoints,
    addPoints: addPoints,
    takePoints: takePoints,
    setEntry: setEntry,
    removeEntry: removeEntry,
    lastScorer: lastScorer,
    suggestNotDown: suggestNotDown,
    handPenalty: handPenalty,
    playerGameScore: playerGameScore,
    inGame: inGame,
    gameScores: gameScores,
    totals: totals,
    wins: wins,
    standings: standings,
    gameTable: gameTable,
    validateResult: validateResult,
    finishGame: finishGame,
    dropOpenGame: dropOpenGame,
    tournamentWinners: tournamentWinners,
    finishTournament: finishTournament,
    reopenTournament: reopenTournament
  };

  root.Rummy = Rummy;
  if (typeof module !== 'undefined' && module.exports) module.exports = Rummy;
})(typeof window !== 'undefined' ? window : globalThis);
