/* Rummy Combos — game rules. Pure functions, no DOM.
   A game object is one evening; its rounds are the games played that evening.
   A round stores only what was entered; scores are always recomputed from it:
     round = { adds: { playerId: [points, ...] },
               result: null | { closerId, entries: { playerId: { points, notDown } } } }
   adds = points scored during the game. At the end, the player who closed scores nothing extra;
   every other player loses the cards left in hand, or 70 when they never went down. */
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

  function touch(game) {
    game.updatedAt = now();
  }

  function newRound() {
    return { adds: {}, result: null };
  }

  function newGame(names, opts) {
    opts = opts || {};
    var t = now();
    return {
      id: uid(),
      createdAt: t,
      updatedAt: t,
      players: names.map(function (name, i) { return { id: 'p' + (i + 1), name: cleanName(name) }; }),
      firstDealer: opts.firstDealer || 0,
      rounds: [newRound()]
    };
  }

  // Index of the open game (the first round without a result), or -1 when there is none.
  function currentIndex(game) {
    for (var i = 0; i < game.rounds.length; i++) {
      if (!game.rounds[i].result) return i;
    }
    return -1;
  }

  function ensureOpenRound(game) {
    if (currentIndex(game) < 0) game.rounds.push(newRound());
    return currentIndex(game);
  }

  // Makes a stored evening safe to use (e.g. one pulled from git): every round has adds,
  // and an evening in progress always has an open game.
  function normalize(game) {
    if (!game) return game;
    if (!Array.isArray(game.rounds)) game.rounds = [];
    game.rounds.forEach(function (r) {
      if (!r.adds || typeof r.adds !== 'object' || Array.isArray(r.adds)) r.adds = {};
      if (r.result === undefined) r.result = null;
    });
    if (!game.finishedAt) ensureOpenRound(game);
    return game;
  }

  function playedCount(game) {
    return game.rounds.filter(function (r) { return r.result; }).length;
  }

  // The dealer moves one seat each game.
  function dealerIndex(game, i) {
    return (game.firstDealer + i) % game.players.length;
  }

  function dealer(game, i) {
    return game.players[dealerIndex(game, i)];
  }

  function playerById(game, id) {
    for (var i = 0; i < game.players.length; i++) {
      if (game.players[i].id === id) return game.players[i];
    }
    return null;
  }

  // ---------- points scored during a game ----------
  // Only whole numbers above 0: points are subtracted only when the game ends.
  function validPoints(n) {
    if (n === '' || n == null) return false;
    n = Number(n);
    return isFinite(n) && n === Math.round(n) && n > 0 && n <= MAX_POINTS;
  }

  function addsOf(round, pid) {
    return (round.adds && round.adds[pid]) || [];
  }

  function addsSum(round, pid) {
    return addsOf(round, pid).reduce(function (s, n) { return s + n; }, 0);
  }

  function hasAdds(round) {
    return Object.keys(round.adds || {}).some(function (pid) { return round.adds[pid].length > 0; });
  }

  // These work on a round, so they also work on a copy being edited. They return false on bad input.
  function addPoints(round, pid, points) {
    if (!validPoints(points)) return false;
    (round.adds[pid] || (round.adds[pid] = [])).push(Number(points));
    return true;
  }

  function setPoints(round, pid, k, points) {
    var list = addsOf(round, pid);
    if (k < 0 || k >= list.length || !validPoints(points)) return false;
    list[k] = Number(points);
    return true;
  }

  function removePoints(round, pid, k) {
    var list = addsOf(round, pid);
    if (k < 0 || k >= list.length) return false;
    list.splice(k, 1);
    if (!list.length) delete round.adds[pid];
    return true;
  }

  // A player who scored nothing during the game never went down.
  function suggestNotDown(round, pid) {
    return addsOf(round, pid).length === 0;
  }

  // ---------- scores ----------
  // What a player who did not close loses at the end of the game.
  function handPenalty(entry) {
    if (!entry) return 0;
    return entry.notDown ? NOT_DOWN_POINTS : (Number(entry.points) || 0);
  }

  function playerRoundPoints(round, result, pid) {
    var scored = addsSum(round, pid);
    if (pid === result.closerId) return scored;
    return scored - handPenalty(result.entries && result.entries[pid]);
  }

  function roundScores(game, round, result) {
    result = result || round.result;
    if (!result) return null;
    var out = {};
    game.players.forEach(function (p) { out[p.id] = playerRoundPoints(round, result, p.id); });
    return out;
  }

  // rows[i] = { scores: {pid: points} | null, totals: {pid: running total} | null }
  function scoreTable(game) {
    var running = {};
    game.players.forEach(function (p) { running[p.id] = 0; });
    var rows = game.rounds.map(function (r) {
      var s = roundScores(game, r);
      if (!s) return { scores: null, totals: null };
      game.players.forEach(function (p) { running[p.id] += s[p.id]; });
      return { scores: s, totals: Object.assign({}, running) };
    });
    return { rows: rows, totals: running };
  }

  function totals(game) {
    return scoreTable(game).totals;
  }

  // Players with the highest total: more points is better.
  function leaders(game) {
    var t = totals(game);
    var max = Math.max.apply(null, game.players.map(function (p) { return t[p.id]; }));
    return game.players.filter(function (p) { return t[p.id] === max; });
  }

  // Sorted standings, highest total first. A recorded winnerId always takes first place.
  function ranking(game) {
    var t = totals(game);
    var rows = game.players.map(function (p) { return { player: p, total: t[p.id], place: 0 }; });
    rows.sort(function (a, b) {
      if (game.winnerId) {
        if (a.player.id === game.winnerId) return -1;
        if (b.player.id === game.winnerId) return 1;
      }
      return b.total - a.total;
    });
    rows.forEach(function (row, i) {
      var prev = rows[i - 1];
      row.place = prev && prev.total === row.total && prev.player.id !== game.winnerId ? prev.place : i + 1;
    });
    return rows;
  }

  // ---------- end of a game ----------
  // Returns a Hebrew error message, or null when the result is complete.
  function validateResult(game, result) {
    if (!result || !playerById(game, result.closerId)) return 'בחר מי ניצח';
    for (var i = 0; i < game.players.length; i++) {
      var p = game.players[i];
      if (p.id === result.closerId) continue;
      var e = result.entries && result.entries[p.id];
      if (!e || (!e.notDown && !(e.points !== '' && e.points != null && isFinite(e.points) && Number(e.points) >= 0))) {
        return 'כמה נקודות נשארו ביד ל' + p.name + '?';
      }
    }
    return null;
  }

  function normalizeResult(game, result) {
    var entries = {};
    game.players.forEach(function (p) {
      if (p.id === result.closerId) return;
      var e = result.entries[p.id];
      entries[p.id] = e.notDown ? { points: 0, notDown: true } : { points: Math.round(Number(e.points)), notDown: false };
    });
    return { closerId: result.closerId, entries: entries };
  }

  // Records how a game ended. Ending the open game opens the next one, dealt by the next player.
  function setResult(game, i, result) {
    game.rounds[i].result = normalizeResult(game, result);
    ensureOpenRound(game);
    touch(game);
  }

  // Ends the evening: the open game, with any points scored in it, is dropped and the winner is recorded.
  function finishGame(game, winnerId) {
    game.rounds = game.rounds.filter(function (r) { return r.result; });
    game.winnerId = winnerId || leaders(game)[0].id;
    game.finishedAt = now();
    touch(game);
    return game;
  }

  var Rummy = {
    NOT_DOWN_POINTS: NOT_DOWN_POINTS,
    MAX_POINTS: MAX_POINTS,
    uid: uid,
    cleanName: cleanName,
    touch: touch,
    newRound: newRound,
    newGame: newGame,
    normalize: normalize,
    currentIndex: currentIndex,
    playedCount: playedCount,
    dealerIndex: dealerIndex,
    dealer: dealer,
    playerById: playerById,
    validPoints: validPoints,
    addsOf: addsOf,
    addsSum: addsSum,
    hasAdds: hasAdds,
    addPoints: addPoints,
    setPoints: setPoints,
    removePoints: removePoints,
    suggestNotDown: suggestNotDown,
    handPenalty: handPenalty,
    playerRoundPoints: playerRoundPoints,
    roundScores: roundScores,
    scoreTable: scoreTable,
    totals: totals,
    leaders: leaders,
    ranking: ranking,
    validateResult: validateResult,
    setResult: setResult,
    finishGame: finishGame
  };

  root.Rummy = Rummy;
  if (typeof module !== 'undefined' && module.exports) module.exports = Rummy;
})(typeof window !== 'undefined' ? window : globalThis);
