(async function () {
  const DATA = window.PLAYER_DATA;
  const STATS_API = "https://statsapi.mlb.com/api/v1";
  const MAX_GUESSES = 6;
  const EPOCH = new Date(2024, 0, 1); // day 0
  const STORAGE_PREFIX = "statline_";

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(arr, seed) {
    const rng = mulberry32(seed);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dayNumber(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((d - EPOCH) / 86400000);
  }

  function todayKey(date) {
    return date.toISOString().slice(0, 10);
  }

  // ---------- per-type index pools (one daily rotation per stat type) ----------
  const TYPE_INDICES = {
    hitter: DATA.map((_, i) => i).filter((i) => DATA[i].type === "hitter"),
    pitcher: DATA.map((_, i) => i).filter((i) => DATA[i].type === "pitcher"),
  };
  const TYPE_SEED = { hitter: 12345, pitcher: 54321 };
  const TYPE_ORDER = {
    hitter: seededShuffle(TYPE_INDICES.hitter, TYPE_SEED.hitter),
    pitcher: seededShuffle(TYPE_INDICES.pitcher, TYPE_SEED.pitcher),
  };

  function puzzleForDate(date, statType) {
    const indices = TYPE_INDICES[statType];
    const baseOrder = TYPE_ORDER[statType];
    const seed = TYPE_SEED[statType];
    const dn = dayNumber(date);
    const cycle = Math.floor(dn / indices.length);
    const posInCycle = ((dn % indices.length) + indices.length) % indices.length;
    // reshuffle order each full cycle so repeats aren't in the same sequence
    const order = cycle === 0 ? baseOrder : seededShuffle(baseOrder, seed + cycle);
    const idx = order[posInCycle];
    return { index: idx, entry: DATA[idx], dayNumber: dn, statType };
  }

  function randomPuzzle(statType, excludeIndex) {
    const indices = TYPE_INDICES[statType];
    let idx;
    do {
      idx = indices[Math.floor(Math.random() * indices.length)];
    } while (indices.length > 1 && idx === excludeIndex);
    return { index: idx, entry: DATA[idx], dayNumber: null, statType };
  }

  const today = new Date();
  const dailyMeta = {
    hitter: puzzleForDate(today, "hitter"),
    pitcher: puzzleForDate(today, "pitcher"),
  };

  // ---------- round state (mutable across mode/type switches) ----------
  let roundMode = "daily"; // "daily" | "random"
  let statType = "hitter"; // "hitter" | "pitcher"
  let puzzle = dailyMeta.hitter;
  let answer = puzzle.entry;
  let saveKey = dailySaveKey(statType);
  let statsSource = "offline";
  let state = { guesses: [], over: false, won: false };

  function dailySaveKey(type) {
    return `${STORAGE_PREFIX}${type}_${todayKey(today)}`;
  }

  function statsKeyFor(type) {
    return `${STORAGE_PREFIX}stats_${type}`;
  }

  // Pull the real season line straight from the MLB Stats API; fall back to
  // the verified numbers baked into data.js if the request fails (offline, etc).
  // WAR/FIP/CG have no MLB Stats API equivalent (they're Baseball-Reference-
  // derived), so those three always come from the baked-in data regardless.
  async function fetchLiveStats(entry) {
    if (!entry.playerId) throw new Error("No playerId for this entry");
    const group = entry.type === "hitter" ? "hitting" : "pitching";
    const url = `${STATS_API}/people/${entry.playerId}/stats?stats=season&group=${group}&season=${entry.year}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
    const json = await res.json();
    const split = json.stats?.[0]?.splits?.[0];
    if (!split) throw new Error("No stats returned");
    const stat = split.stat;
    if (entry.type === "hitter") {
      return {
        G: stat.gamesPlayed,
        AVG: parseFloat(stat.avg),
        HR: stat.homeRuns,
        RBI: stat.rbi,
        R: stat.runs,
        SB: stat.stolenBases,
        BB: stat.baseOnBalls,
        OPS: parseFloat(stat.ops),
      };
    }
    return {
      G: stat.gamesPlayed,
      W: stat.wins,
      L: stat.losses,
      ERA: parseFloat(stat.era),
      SO: stat.strikeOuts,
      IP: parseFloat(stat.inningsPitched),
      BB: stat.baseOnBalls,
    };
  }

  function loadDailyState(type) {
    try {
      const raw = localStorage.getItem(dailySaveKey(type));
      if (raw) {
        const parsed = JSON.parse(raw);
        // guard against the older string-array guess format
        if (
          Array.isArray(parsed.guesses) &&
          (parsed.guesses.length === 0 || typeof parsed.guesses[0] === "object")
        ) {
          return parsed;
        }
      }
    } catch (e) {}
    return { guesses: [], over: false, won: false };
  }

  function saveState() {
    if (roundMode !== "daily") return;
    localStorage.setItem(saveKey, JSON.stringify(state));
  }

  function loadStats(type) {
    try {
      const raw = localStorage.getItem(statsKeyFor(type));
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { played: 0, wins: 0, currentStreak: 0, maxStreak: 0, lastWinDay: null };
  }

  function saveStats(type, s) {
    localStorage.setItem(statsKeyFor(type), JSON.stringify(s));
  }

  function recordResult(type, won, dn) {
    const s = loadStats(type);
    s.played += 1;
    if (won) {
      s.wins += 1;
      if (s.lastWinDay === dn - 1) {
        s.currentStreak += 1;
      } else {
        s.currentStreak = 1;
      }
      s.lastWinDay = dn;
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    } else {
      s.currentStreak = 0;
    }
    saveStats(type, s);
  }

  // ---------- DOM ----------
  const els = {
    statTable: document.getElementById("stat-table"),
    statHeader: document.getElementById("stat-header"),
    statSource: document.getElementById("stat-source"),
    puzzleLabel: document.getElementById("puzzle-label"),
    guessForm: document.getElementById("guess-form"),
    guessInput: document.getElementById("guess-input"),
    playerList: document.getElementById("player-list"),
    guessGridBody: document.getElementById("guess-grid-body"),
    message: document.getElementById("message"),
    guessesLeft: document.getElementById("guesses-left"),
    shareBtn: document.getElementById("share-btn"),
    newRoundBtn: document.getElementById("new-round-btn"),
    typeHitter: document.getElementById("type-hitter"),
    typePitcher: document.getElementById("type-pitcher"),
    modeDaily: document.getElementById("mode-daily"),
    modeRandom: document.getElementById("mode-random"),
    statsBtn: document.getElementById("stats-btn"),
    statsModal: document.getElementById("stats-modal"),
    statsBodyHitter: document.getElementById("stats-body-hitter"),
    statsBodyPitcher: document.getElementById("stats-body-pitcher"),
    closeModal: document.getElementById("close-modal"),
  };

  function uniquePlayerNames() {
    return [...new Set(DATA.map((d) => d.player))].sort();
  }

  function populateDatalist() {
    els.playerList.innerHTML = uniquePlayerNames()
      .map((n) => `<option value="${n}"></option>`)
      .join("");
  }

  function renderStatLine() {
    const type = answer.type;
    els.statHeader.textContent =
      type === "hitter" ? "Hitter — Season Stat Line" : "Pitcher — Season Stat Line";

    let rows;
    if (type === "hitter") {
      const s = answer.stats;
      rows = [
        ["G", s.G],
        ["AVG", s.AVG.toFixed(3).replace(/^0/, "")],
        ["HR", s.HR],
        ["RBI", s.RBI],
        ["R", s.R],
        ["SB", s.SB],
        ["BB", s.BB],
        ["OPS", s.OPS.toFixed(3).replace(/^0/, "")],
        ["WAR", s.WAR.toFixed(1)],
      ];
    } else {
      const s = answer.stats;
      rows = [
        ["G", s.G],
        ["W", s.W],
        ["L", s.L],
        ["ERA", s.ERA.toFixed(2)],
        ["SO", s.SO],
        ["IP", s.IP],
        ["BB", s.BB],
        ["WAR", s.WAR.toFixed(1)],
        ["FIP", s.FIP.toFixed(2)],
        ["CG", s.CG],
      ];
    }

    els.statTable.innerHTML =
      "<tr>" +
      rows.map(([label]) => `<th>${label}</th>`).join("") +
      "</tr><tr>" +
      rows.map(([, val]) => `<td>${val}</td>`).join("") +
      "</tr>";
  }

  // ---------- guess comparison (Poeltl/Immaculate-Grid style) ----------
  function compareExact(guessVal, answerVal) {
    return guessVal === answerVal ? "green" : "gray";
  }

  // numeric closeness: exact match is green, within `tolerance` is yellow,
  // otherwise gray; arrow points which way to adjust the next guess (bigger
  // number = later year, so up = later, down = earlier)
  function compareClose(guessVal, answerVal, tolerance) {
    const diff = guessVal - answerVal;
    if (diff === 0) return { status: "green", arrow: "" };
    return { status: Math.abs(diff) <= tolerance ? "yellow" : "gray", arrow: diff < 0 ? "↑" : "↓" };
  }

  // rank is inverted from normal numeric intuition: 1st is the best finish,
  // so "up" means toward 1st and "down" means toward 10th, regardless of
  // which award race the comparison entry came from
  function compareRank(guessRank, answerRank, tolerance) {
    const diff = guessRank - answerRank;
    if (diff === 0) return { status: "green", arrow: "" };
    return { status: Math.abs(diff) <= tolerance ? "yellow" : "gray", arrow: diff > 0 ? "↑" : "↓" };
  }

  const POSITION_CATEGORY = {
    C: "C",
    "1B": "IF",
    "2B": "IF",
    "3B": "IF",
    SS: "IF",
    LF: "OF",
    CF: "OF",
    RF: "OF",
    DH: "DH",
    P: "P",
  };

  function comparePosition(guessPos, answerPos) {
    if (guessPos === answerPos) return "green";
    if (POSITION_CATEGORY[guessPos] === POSITION_CATEGORY[answerPos]) return "yellow";
    return "gray";
  }

  function compareDivision(guessDiv, answerDiv) {
    if (guessDiv === answerDiv) return "green";
    const guessRegion = guessDiv.split(" ")[1];
    const answerRegion = answerDiv.split(" ")[1];
    return guessRegion === answerRegion ? "yellow" : "gray";
  }

  function buildCells(entry) {
    const year = compareClose(entry.year, answer.year, 3);
    const rank = compareRank(entry.rank, answer.rank, 3);
    const awardLabel = entry.award === "Cy Young" ? "CY" : "MVP";
    return {
      year: { status: year.status, text: `${entry.year}${year.arrow ? " " + year.arrow : ""}` },
      league: { status: compareExact(entry.league, answer.league), text: entry.league },
      division: {
        status: compareDivision(entry.division, answer.division),
        text: entry.division.split(" ")[1],
      },
      team: { status: compareExact(entry.team, answer.team), text: entry.teamAbbr },
      position: { status: comparePosition(entry.position, answer.position), text: entry.position },
      award: {
        status: rank.status,
        text: `${awardLabel} #${entry.rank}${rank.arrow ? " " + rank.arrow : ""}`,
      },
    };
  }

  function cellHtml(cell) {
    return `<td class="cell ${cell.status}">${cell.text}</td>`;
  }

  function renderGuessGrid() {
    els.guessGridBody.innerHTML = state.guesses
      .map(
        (g) => `<tr>
          <td class="player-name">${g.name}</td>
          ${cellHtml(g.cells.year)}
          ${cellHtml(g.cells.league)}
          ${cellHtml(g.cells.division)}
          ${cellHtml(g.cells.team)}
          ${cellHtml(g.cells.position)}
          ${cellHtml(g.cells.award)}
        </tr>`
      )
      .join("");
  }

  function renderGuessesLeft() {
    const left = MAX_GUESSES - state.guesses.length;
    els.guessesLeft.textContent = state.over ? "" : `${left} guess${left === 1 ? "" : "es"} left`;
  }

  function normalize(str) {
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z]/g, "");
  }

  function showMessage(text, type) {
    els.message.textContent = text;
    els.message.className = "message " + (type || "");
  }

  function endGame(won) {
    if (state.over) return;
    state.over = true;
    state.won = won;
    saveState();
    if (roundMode === "daily") recordResult(statType, won, puzzle.dayNumber);
    if (won) {
      showMessage(`Correct! It was ${answer.player} (${answer.team}, ${answer.year}).`, "success");
    } else {
      showMessage(`Out of guesses. The answer was ${answer.player} (${answer.team}, ${answer.year}).`, "fail");
    }
    els.guessInput.disabled = true;
    els.guessForm.querySelector("button").disabled = true;
    els.shareBtn.hidden = false;
    renderGuessesLeft();
  }

  function submitGuess(raw) {
    if (state.over) return;
    const guess = raw.trim();
    if (!guess) return;

    const normGuess = normalize(guess);
    const matches = DATA.filter((d) => normalize(d.player) === normGuess);
    if (matches.length === 0) {
      showMessage("Not a recognized player — pick one from the suggestions.", "info");
      return;
    }

    // compare against whichever of that player's seasons is closest to the
    // answer's year (the most favorable, most informative comparison)
    const entry = matches.reduce((best, e) =>
      Math.abs(e.year - answer.year) < Math.abs(best.year - answer.year) ? e : best
    );
    const correct = normGuess === normalize(answer.player);
    const cells = buildCells(entry);
    state.guesses.push({ name: entry.player, correct, cells });
    saveState();
    renderGuessGrid();

    if (correct) {
      endGame(true);
      return;
    }

    if (state.guesses.length >= MAX_GUESSES) {
      endGame(false);
      return;
    }

    renderGuessesLeft();
    showMessage("Not quite — check the grid for clues.", "info");
  }

  function statusEmoji(status) {
    return status === "green" ? "🟩" : status === "yellow" ? "🟨" : "⬛";
  }

  function buildShareText() {
    const rows = state.guesses.map((g) =>
      ["year", "league", "division", "team", "position", "award"]
        .map((k) => statusEmoji(g.cells[k].status))
        .join("")
    );
    const result = state.won ? `${state.guesses.length}/${MAX_GUESSES}` : "X/" + MAX_GUESSES;
    const typeLabel = statType === "hitter" ? "Hitter" : "Pitcher";
    const lines = [
      roundMode === "daily"
        ? `MLB Stat Line — ${typeLabel} #${puzzle.dayNumber} — ${result}`
        : `MLB Stat Line — ${typeLabel} (Practice) — ${result}`,
      rows.join("\n"),
    ];
    if (roundMode === "daily") {
      const s = loadStats(statType);
      lines.push(`Streak: ${s.currentStreak} 🔥`);
    }
    return lines.join("\n");
  }

  function statsGridHtml(s) {
    const winPct = s.played ? Math.round((s.wins / s.played) * 100) : 0;
    return `
      <div class="stats-grid">
        <div><div class="stat-num">${s.played}</div><div class="stat-label">Played</div></div>
        <div><div class="stat-num">${winPct}</div><div class="stat-label">Win %</div></div>
        <div><div class="stat-num">${s.currentStreak}</div><div class="stat-label">Streak</div></div>
        <div><div class="stat-num">${s.maxStreak}</div><div class="stat-label">Max Streak</div></div>
      </div>
    `;
  }

  function renderStatsModal() {
    els.statsBodyHitter.innerHTML = statsGridHtml(loadStats("hitter"));
    els.statsBodyPitcher.innerHTML = statsGridHtml(loadStats("pitcher"));
  }

  // ---------- round lifecycle ----------
  function renderRound() {
    renderStatLine();
    els.statSource.textContent =
      statsSource === "live"
        ? "Live from MLB Stats API"
        : "Offline backup data (MLB Stats API unavailable)";
    const typeLabel = statType === "hitter" ? "Hitter" : "Pitcher";
    els.puzzleLabel.textContent =
      roundMode === "daily" ? `Daily ${typeLabel} Puzzle #${puzzle.dayNumber}` : `Practice Round (${typeLabel})`;
    renderGuessGrid();
    renderGuessesLeft();

    els.guessInput.disabled = false;
    els.guessForm.querySelector("button").disabled = false;
    els.guessInput.value = "";
    els.shareBtn.hidden = true;
    showMessage("", "");

    if (state.over) {
      els.guessInput.disabled = true;
      els.guessForm.querySelector("button").disabled = true;
      els.shareBtn.hidden = false;
      if (state.won) {
        showMessage(`Correct! It was ${answer.player} (${answer.team}, ${answer.year}).`, "success");
      } else {
        showMessage(`Out of guesses. The answer was ${answer.player} (${answer.team}, ${answer.year}).`, "fail");
      }
    }
  }

  async function activateRound(meta, newRoundMode) {
    roundMode = newRoundMode;
    statType = meta.statType;
    puzzle = meta;
    answer = meta.entry;
    saveKey = dailySaveKey(statType);
    state = roundMode === "daily" ? loadDailyState(statType) : { guesses: [], over: false, won: false };

    els.typeHitter.classList.toggle("active", statType === "hitter");
    els.typeHitter.setAttribute("aria-selected", statType === "hitter");
    els.typePitcher.classList.toggle("active", statType === "pitcher");
    els.typePitcher.setAttribute("aria-selected", statType === "pitcher");
    els.modeDaily.classList.toggle("active", roundMode === "daily");
    els.modeDaily.setAttribute("aria-selected", roundMode === "daily");
    els.modeRandom.classList.toggle("active", roundMode === "random");
    els.modeRandom.setAttribute("aria-selected", roundMode === "random");
    els.newRoundBtn.hidden = roundMode !== "random";

    els.statHeader.textContent = "Loading…";
    els.statTable.innerHTML = "";
    els.statSource.textContent = "";
    els.guessInput.disabled = true;
    els.guessForm.querySelector("button").disabled = true;

    statsSource = "offline";
    try {
      const live = await fetchLiveStats(answer);
      // WAR/FIP/CG aren't part of the MLB Stats API payload, so keep whatever
      // baked-in values are already on this entry and only overlay the rest
      answer.stats = { ...answer.stats, ...live };
      statsSource = "live";
    } catch (e) {
      console.warn("Falling back to offline stat line:", e);
    }

    renderRound();
  }

  // ---------- wire up ----------
  populateDatalist();
  await activateRound(dailyMeta.hitter, "daily");

  els.guessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitGuess(els.guessInput.value);
    els.guessInput.value = "";
  });

  els.shareBtn.addEventListener("click", async () => {
    const text = buildShareText();
    try {
      await navigator.clipboard.writeText(text);
      showMessage("Result copied to clipboard!", "success");
    } catch (e) {
      showMessage(text, "success");
    }
  });

  els.statsBtn.addEventListener("click", () => {
    renderStatsModal();
    els.statsModal.hidden = false;
  });

  els.closeModal.addEventListener("click", () => {
    els.statsModal.hidden = true;
  });

  els.typeHitter.addEventListener("click", () => {
    if (statType === "hitter") return;
    const meta = roundMode === "daily" ? dailyMeta.hitter : randomPuzzle("hitter", dailyMeta.hitter.index);
    activateRound(meta, roundMode);
  });

  els.typePitcher.addEventListener("click", () => {
    if (statType === "pitcher") return;
    const meta = roundMode === "daily" ? dailyMeta.pitcher : randomPuzzle("pitcher", dailyMeta.pitcher.index);
    activateRound(meta, roundMode);
  });

  els.modeDaily.addEventListener("click", () => {
    if (roundMode === "daily") return;
    activateRound(dailyMeta[statType], "daily");
  });

  els.modeRandom.addEventListener("click", () => {
    activateRound(randomPuzzle(statType, dailyMeta[statType].index), "random");
  });

  els.newRoundBtn.addEventListener("click", () => {
    activateRound(randomPuzzle(statType, dailyMeta[statType].index), "random");
  });
})();
