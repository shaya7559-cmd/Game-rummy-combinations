/* Rummy Combos — summaries. Pure functions, no DOM.
   Only finished games count. Players are matched across tournaments by name. */
(function (root) {
  'use strict';

  var R = root.Rummy;

  function live(list) {
    return list.filter(function (t) { return !t.deleted; });
  }

  // One tournament: per player points, wins, games played, times not down and best game,
  // most points first. winners = the tournament winners once it is finished.
  function tournamentSummary(tour) {
    var byId = {};
    tour.players.forEach(function (p, i) {
      byId[p.id] = { player: p, name: p.name, seat: i, points: 0, wins: 0, games: 0, notDowns: 0, best: null, place: 0 };
    });
    var games = R.finishedGames(tour);
    games.forEach(function (g) {
      var scores = R.gameScores(tour, g);
      tour.players.forEach(function (p) {
        if (!R.inGame(g, p.id)) return;
        var s = byId[p.id];
        s.games++;
        s.points += scores[p.id];
        if (g.result.winnerId === p.id) s.wins++;
        var h = g.result.hands[p.id];
        if (h && h.notDown) s.notDowns++;
        if (s.best === null || scores[p.id] > s.best) s.best = scores[p.id];
      });
    });
    var players = tour.players.map(function (p) { return byId[p.id]; });
    players.sort(function (a, b) { return b.points - a.points || b.wins - a.wins || a.seat - b.seat; });
    players.forEach(function (s, i) {
      var prev = players[i - 1];
      s.place = prev && prev.points === s.points ? prev.place : i + 1;
      s.avg = s.games ? s.points / s.games : 0;
    });
    var winners = tour.finishedAt ? (tour.winnerIds || []).map(function (id) { return byId[id]; }).filter(Boolean) : null;
    return { tournament: tour, games: games.length, players: players, winners: winners };
  }

  // Running tournaments first, then the rest; most recently played first.
  function byTournament(list) {
    return live(list).map(tournamentSummary).sort(function (a, b) {
      return (!!a.tournament.finishedAt - !!b.tournament.finishedAt) ||
        (b.tournament.updatedAt || '').localeCompare(a.tournament.updatedAt || '');
    });
  }

  // All tournaments together: per player points, wins, games, tournaments played and won.
  function overall(list) {
    var byName = {};
    var general = { tournaments: 0, finished: 0, games: 0, notDowns: 0, bestGame: null, mostWins: null };

    function stat(name) {
      return byName[name] || (byName[name] = {
        name: name, points: 0, wins: 0, games: 0, notDowns: 0, tournaments: 0, tournamentWins: 0, best: null
      });
    }

    live(list).forEach(function (t) {
      var sum = tournamentSummary(t);
      if (!sum.games) return;
      general.tournaments++;
      general.games += sum.games;
      if (t.finishedAt) general.finished++;
      sum.players.forEach(function (row) {
        if (!row.games) return;
        var s = stat(row.name);
        s.points += row.points;
        s.wins += row.wins;
        s.games += row.games;
        s.notDowns += row.notDowns;
        s.tournaments++;
        general.notDowns += row.notDowns;
        if (s.best === null || row.best > s.best) s.best = row.best;
        if (sum.winners && sum.winners.indexOf(row) >= 0) s.tournamentWins++;
        if (row.wins && (!general.mostWins || row.wins > general.mostWins.wins)) {
          general.mostWins = { name: row.name, wins: row.wins, tournament: t.name };
        }
      });
      R.finishedGames(t).forEach(function (g) {
        var scores = R.gameScores(t, g);
        t.players.forEach(function (p) {
          if (!R.inGame(g, p.id)) return;
          if (!general.bestGame || scores[p.id] > general.bestGame.points) {
            general.bestGame = { name: p.name, points: scores[p.id], tournament: t.name, number: R.gameNumber(t, g), date: g.finishedAt };
          }
        });
      });
    });

    var players = Object.keys(byName).map(function (name) {
      var s = byName[name];
      s.avg = s.games ? s.points / s.games : 0;
      return s;
    });
    players.sort(function (a, b) { return b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, 'he'); });
    return { players: players, general: general };
  }

  // Names that played before, most frequent first (offered when opening a tournament).
  function playerNames(list) {
    var seen = {};
    live(list).forEach(function (t) {
      t.players.forEach(function (p) { seen[p.name] = (seen[p.name] || 0) + 1 + R.finishedGames(t).length / 1000; });
    });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b, 'he'); });
  }

  var RummyStats = {
    live: live,
    tournamentSummary: tournamentSummary,
    byTournament: byTournament,
    overall: overall,
    playerNames: playerNames
  };

  root.RummyStats = RummyStats;
  if (typeof module !== 'undefined' && module.exports) module.exports = RummyStats;
})(typeof window !== 'undefined' ? window : globalThis);
