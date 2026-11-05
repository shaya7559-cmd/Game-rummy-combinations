/* Rummy Combos — reports over finished games. Pure functions, no DOM.
   Players are matched across games by name. */
(function (root) {
  'use strict';

  var R = root.Rummy;

  function finished(games) {
    return games.filter(function (g) { return g.finishedAt; })
      .sort(function (a, b) { return a.finishedAt.localeCompare(b.finishedAt); });
  }

  // tournamentId: 'all' or one tournament's id
  function filterByTournament(games, tournamentId) {
    if (!tournamentId || tournamentId === 'all') return games.slice();
    return games.filter(function (g) { return g.tournamentId === tournamentId; });
  }

  // period: 'all' | 'year' (this calendar year) | '30d' (last 30 days)
  function filterByPeriod(games, period, nowDate) {
    var now = nowDate || new Date();
    if (period === 'year') {
      return games.filter(function (g) { return new Date(g.finishedAt).getFullYear() === now.getFullYear(); });
    }
    if (period === '30d') {
      var from = now.getTime() - 30 * 24 * 3600 * 1000;
      return games.filter(function (g) { return new Date(g.finishedAt).getTime() >= from; });
    }
    return games.slice();
  }

  function lastGame(games) {
    var list = finished(games);
    return list.length ? list[list.length - 1] : null;
  }

  function playerNames(games) {
    var seen = {};
    finished(games).forEach(function (g) {
      g.players.forEach(function (p) { seen[p.name] = (seen[p.name] || 0) + 1; });
    });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b, 'he'); });
  }

  // A game object is one evening and its rounds are the games played that evening.
  // games/wins/totalPoints count evenings; roundsPlayed/closes/notDowns count games.
  function summary(games) {
    var list = finished(games);
    var byName = {};
    var general = {
      games: list.length, rounds: 0, notDowns: 0,
      bestRound: null, bestGame: null, longestStreak: null, mostWins: null, mostCloses: null
    };

    function stat(name) {
      return byName[name] || (byName[name] = {
        name: name, games: 0, wins: 0, placeSum: 0, totalPoints: 0, best: null, worst: null,
        roundsPlayed: 0, closes: 0, notDowns: 0, scored: 0, lost: 0, bestRound: null,
        streak: 0, longestStreak: 0
      });
    }

    list.forEach(function (g) {
      R.ranking(g).forEach(function (row) {
        var s = stat(row.player.name);
        s.games++;
        s.placeSum += row.place;
        s.totalPoints += row.total;
        if (s.best === null || row.total > s.best) s.best = row.total;
        if (s.worst === null || row.total < s.worst) s.worst = row.total;
        if (!general.bestGame || row.total > general.bestGame.points) {
          general.bestGame = { name: row.player.name, points: row.total, date: g.finishedAt, gameId: g.id };
        }
        if (row.player.id === g.winnerId) {
          s.wins++;
          s.streak++;
          s.longestStreak = Math.max(s.longestStreak, s.streak);
        } else {
          s.streak = 0;
        }
      });

      var table = R.scoreTable(g);
      g.rounds.forEach(function (r, i) {
        if (!r.result) return;
        general.rounds++;
        var scores = table.rows[i].scores;
        g.players.forEach(function (p) {
          var s = stat(p.name);
          var pts = scores[p.id];
          s.roundsPlayed++;
          s.scored += R.addsSum(r, p.id);
          if (s.bestRound === null || pts > s.bestRound) s.bestRound = pts;
          if (!general.bestRound || pts > general.bestRound.points) {
            general.bestRound = { name: p.name, points: pts, date: g.finishedAt, round: i + 1, gameId: g.id };
          }
          if (p.id === r.result.closerId) {
            s.closes++;
            return;
          }
          var e = r.result.entries[p.id];
          s.lost += R.handPenalty(e);
          if (e && e.notDown) {
            s.notDowns++;
            general.notDowns++;
          }
        });
      });
    });

    var players = Object.keys(byName).map(function (name) {
      var s = byName[name];
      s.winPct = s.games ? s.wins / s.games : 0;
      s.avgPlace = s.games ? s.placeSum / s.games : 0;
      s.avgPoints = s.games ? s.totalPoints / s.games : 0;
      s.closePct = s.roundsPlayed ? s.closes / s.roundsPlayed : 0;
      s.avgRound = s.roundsPlayed ? (s.scored - s.lost) / s.roundsPlayed : 0;
      s.currentStreak = s.streak;
      delete s.streak;
      return s;
    });
    // Leader = most evening wins; a tie goes to more total points.
    players.sort(function (a, b) {
      return b.wins - a.wins || b.totalPoints - a.totalPoints || a.name.localeCompare(b.name, 'he');
    });

    players.forEach(function (s) {
      if (s.longestStreak && (!general.longestStreak || s.longestStreak > general.longestStreak.length)) {
        general.longestStreak = { name: s.name, length: s.longestStreak };
      }
      if (s.wins && (!general.mostWins || s.wins > general.mostWins.wins)) {
        general.mostWins = { name: s.name, wins: s.wins };
      }
      if (s.closes && (!general.mostCloses || s.closes > general.mostCloses.closes)) {
        general.mostCloses = { name: s.name, closes: s.closes };
      }
    });

    return { players: players, general: general };
  }

  // Evenings both played: who finished with the higher total.
  function headToHead(games, nameA, nameB) {
    var out = { together: 0, a: 0, b: 0, even: 0 };
    finished(games).forEach(function (g) {
      var pa = null, pb = null;
      g.players.forEach(function (p) {
        if (p.name === nameA) pa = p;
        if (p.name === nameB) pb = p;
      });
      if (!pa || !pb || pa === pb) return;
      out.together++;
      var rank = R.ranking(g);
      var ia = -1, ib = -1;
      rank.forEach(function (row, i) {
        if (row.player === pa) ia = i;
        if (row.player === pb) ib = i;
      });
      if (rank[ia].total === rank[ib].total && pa.id !== g.winnerId && pb.id !== g.winnerId) out.even++;
      else if (ia < ib) out.a++;
      else out.b++;
    });
    return out;
  }

  // Union by id. When both sides have a game, the one updated last wins.
  function mergeHistory(local, incoming) {
    var map = {};
    var added = 0;
    local.forEach(function (g) { map[g.id] = g; });
    (incoming || []).forEach(function (g) {
      if (!g || !g.id || !g.finishedAt) return;
      var have = map[g.id];
      if (!have) added++;
      if (!have || (g.updatedAt || '') > (have.updatedAt || '')) map[g.id] = g;
    });
    return { games: finished(Object.keys(map).map(function (id) { return map[id]; })), added: added };
  }

  var RummyStats = {
    finished: finished,
    filterByTournament: filterByTournament,
    filterByPeriod: filterByPeriod,
    lastGame: lastGame,
    playerNames: playerNames,
    summary: summary,
    headToHead: headToHead,
    mergeHistory: mergeHistory
  };

  root.RummyStats = RummyStats;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyStats;
})(typeof window !== 'undefined' ? window : globalThis);
