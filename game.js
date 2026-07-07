(async function () {
  const DATA = window.PLAYER_DATA;
  // Every MLB player-season with real playing time, 2000-present — this is
  // the guessable pool. Only DATA (top-10 finishers) is ever the *answer*;
  // ALL_PLAYERS just lets you guess anyone and still get useful hints,
  // showing "N/A" for award/rank on seasons that didn't crack the top 10.
  const ALL_PLAYERS = window.ALL_PLAYERS || DATA;
  const STATS_API = "https://statsapi.mlb.com/api/v1";
  const MAX_GUESSES = 6;
  const EPOCH = new Date(2024, 0, 1); // day 0
  const STORAGE_PREFIX = "statline_";
  const GAME_URL = "https://michaelmassey13.github.io/stat-line/";
  // Set this to your Formspree endpoint (e.g. "https://formspree.io/f/xxxxxxx")
  // to wire up the feedback form; left blank it falls back to a mailto: link.
  const FEEDBACK_ENDPOINT = "";

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

  // normalized player name -> all of that player's qualifying seasons, sorted
  const PLAYER_SEASONS = new Map();
  ALL_PLAYERS.forEach((d) => {
    const key = normalize(d.player);
    if (!PLAYER_SEASONS.has(key)) PLAYER_SEASONS.set(key, []);
    PLAYER_SEASONS.get(key).push(d);
  });
  PLAYER_SEASONS.forEach((entries) => entries.sort((a, b) => a.year - b.year));

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

  // Random mode is locked behind finishing that stat type's daily puzzle —
  // the daily game is the priority, random is just a bonus once it's done
  function isDailyDone(type) {
    return loadDailyState(type).over;
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
    autocompleteList: document.getElementById("autocomplete-list"),
    seasonSelect: document.getElementById("season-select"),
    seasonHint: document.getElementById("season-hint"),
    guessGridBody: document.getElementById("guess-grid-body"),
    message: document.getElementById("message"),
    guessesLeft: document.getElementById("guesses-left"),
    shareBtn: document.getElementById("share-btn"),
    newRoundBtn: document.getElementById("new-round-btn"),
    typeHitter: document.getElementById("type-hitter"),
    typePitcher: document.getElementById("type-pitcher"),
    modeDaily: document.getElementById("mode-daily"),
    modeRandom: document.getElementById("mode-random"),
    randomLockHint: document.getElementById("random-lock-hint"),
    statsBtn: document.getElementById("stats-btn"),
    statsModal: document.getElementById("stats-modal"),
    statsBodyHitter: document.getElementById("stats-body-hitter"),
    statsBodyPitcher: document.getElementById("stats-body-pitcher"),
    closeModal: document.getElementById("close-modal"),
    shareModal: document.getElementById("share-modal"),
    sharePreview: document.getElementById("share-preview"),
    shareNativeBtn: document.getElementById("share-native-btn"),
    shareCopyBtn: document.getElementById("share-copy-btn"),
    shareSmsBtn: document.getElementById("share-sms-btn"),
    shareEmailBtn: document.getElementById("share-email-btn"),
    closeShareModal: document.getElementById("close-share-modal"),
    feedbackBtn: document.getElementById("feedback-btn"),
    feedbackModal: document.getElementById("feedback-modal"),
    feedbackForm: document.getElementById("feedback-form"),
    feedbackMessage: document.getElementById("feedback-message"),
    feedbackContact: document.getElementById("feedback-contact"),
    feedbackStatus: document.getElementById("feedback-status"),
    closeFeedbackModal: document.getElementById("close-feedback-modal"),
  };

  const UNIQUE_PLAYER_NAMES = [...new Set(ALL_PLAYERS.map((d) => d.player))].sort();

  // ---------- autocomplete dropdown ----------
  const MAX_SUGGESTIONS = 8;

  function suggestionsFor(raw) {
    const q = normalize(raw);
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const name of UNIQUE_PLAYER_NAMES) {
      const n = normalize(name);
      if (n.startsWith(q)) starts.push(name);
      else if (n.includes(q)) contains.push(name);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return starts.concat(contains).slice(0, MAX_SUGGESTIONS);
  }

  function renderAutocomplete() {
    const matches = suggestionsFor(els.guessInput.value);
    if (matches.length === 0) {
      els.autocompleteList.hidden = true;
      els.autocompleteList.innerHTML = "";
      return;
    }
    els.autocompleteList.innerHTML = matches.map((n) => `<li>${n}</li>`).join("");
    els.autocompleteList.hidden = false;
  }

  function hideAutocomplete() {
    els.autocompleteList.hidden = true;
    els.autocompleteList.innerHTML = "";
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

  const HINT_DESCRIPTIONS = {
    year: "Yellow = within 3 years of the answer",
    debut: "Yellow = debut year within 3 years of the answer's debut year",
    league: "Exact match only (AL or NL)",
    division: "Yellow = same region (East/Central/West), different league",
    team: "Exact match only",
    position: "Yellow = same category as the answer (Infield / Outfield / Catcher / DH)",
    award: "Yellow = finished within 3 spots of the answer's actual voting rank",
  };

  // a guessed player-season that never cracked the top 10 has no rank to
  // compare, so the Award hint is a plain "N/A" — no color, no arrow
  function buildAwardCell(entry) {
    if (entry.rank == null || entry.award == null) {
      return { status: "gray", text: "N/A" };
    }
    const rank = compareRank(entry.rank, answer.rank, 3);
    const awardLabel = entry.award === "Cy Young" ? "CY" : "MVP";
    return { status: rank.status, text: `${awardLabel} #${entry.rank}${rank.arrow ? " " + rank.arrow : ""}` };
  }

  function buildCells(entry) {
    const year = compareClose(entry.year, answer.year, 3);
    const debutCell =
      entry.debutYear == null
        ? { status: "gray", text: "N/A" }
        : (() => {
            const d = compareClose(entry.debutYear, answer.debutYear, 3);
            return { status: d.status, text: `${entry.debutYear}${d.arrow ? " " + d.arrow : ""}` };
          })();
    return {
      year: { status: year.status, text: `${entry.year}${year.arrow ? " " + year.arrow : ""}` },
      debut: debutCell,
      league: { status: compareExact(entry.league, answer.league), text: entry.league },
      division: {
        status: compareDivision(entry.division, answer.division),
        text: entry.division.split(" ")[1],
      },
      team: { status: compareExact(entry.team, answer.team), text: entry.teamAbbr },
      position: { status: comparePosition(entry.position, answer.position), text: entry.position },
      award: buildAwardCell(entry),
    };
  }

  function cellHtml(cell, category) {
    const title = HINT_DESCRIPTIONS[category] ? ` title="${HINT_DESCRIPTIONS[category]}"` : "";
    return `<td class="cell ${cell.status}"${title}>${cell.text}</td>`;
  }

  function renderGuessGrid() {
    els.guessGridBody.innerHTML = state.guesses
      .map(
        (g) => `<tr>
          <td class="player-name${g.playerMatch ? " player-match" : ""}">${g.name}</td>
          ${cellHtml(g.cells.year, "year")}
          ${cellHtml(g.cells.league, "league")}
          ${cellHtml(g.cells.division, "division")}
          ${cellHtml(g.cells.team, "team")}
          ${cellHtml(g.cells.position, "position")}
          ${cellHtml(g.cells.award, "award")}
          ${cellHtml(g.cells.debut, "debut")}
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

  function updateRandomLockUI() {
    const dailyDone = isDailyDone(statType);
    els.modeRandom.disabled = !dailyDone;
    els.modeRandom.textContent = dailyDone ? "Random" : "🔒 Random";
    els.randomLockHint.textContent = dailyDone
      ? ""
      : `Finish today's Daily ${statType === "hitter" ? "Hitter" : "Pitcher"} puzzle to unlock Random.`;
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
    updateRandomLockUI();
  }

  function resetSeasonPicker() {
    els.seasonSelect.innerHTML = "";
    els.seasonSelect.hidden = true;
    els.seasonHint.hidden = true;
  }

  // shows/populates the season dropdown whenever the typed name matches a
  // player with more than one qualifying season, since the stat line could
  // be any one of them
  function updateSeasonPicker() {
    const seasons = PLAYER_SEASONS.get(normalize(els.guessInput.value.trim()));
    if (!seasons || seasons.length <= 1) {
      resetSeasonPicker();
      return;
    }
    els.seasonSelect.innerHTML =
      `<option value="">Season…</option>` +
      seasons
        .map((e) => {
          const label = e.rank != null ? `${e.award === "Cy Young" ? "CY" : "MVP"} #${e.rank}` : "unranked";
          return `<option value="${e.year}">${e.year} (${label})</option>`;
        })
        .join("");
    els.seasonSelect.hidden = false;
    els.seasonHint.hidden = false;
  }

  // returns true if a guess was actually consumed, false if the guess was
  // rejected/blocked (unrecognized player, or a season still needs picking)
  function submitGuess(raw) {
    if (state.over) return false;
    const guess = raw.trim();
    if (!guess) return false;

    const normGuess = normalize(guess);
    const matches = ALL_PLAYERS.filter((d) => normalize(d.player) === normGuess);
    if (matches.length === 0) {
      showMessage("Not a recognized player — pick one from the suggestions.", "info");
      return false;
    }

    let entry;
    if (matches.length === 1) {
      entry = matches[0];
    } else {
      const seasonVal = els.seasonSelect.value;
      if (!seasonVal) {
        showMessage("This player has multiple qualifying seasons — pick one from the Season dropdown.", "info");
        return false;
      }
      entry = matches.find((m) => m.year === Number(seasonVal));
    }

    const playerMatch = entry.player === answer.player;
    const correct = playerMatch && entry.year === answer.year;
    const cells = buildCells(entry);
    state.guesses.push({ name: entry.player, correct, playerMatch, cells });
    saveState();
    renderGuessGrid();
    resetSeasonPicker();

    if (correct) {
      endGame(true);
      return true;
    }

    if (state.guesses.length >= MAX_GUESSES) {
      endGame(false);
      return true;
    }

    renderGuessesLeft();
    showMessage("Not quite — check the grid for clues.", "info");
    return true;
  }

  function statusEmoji(status) {
    return status === "green" ? "🟩" : status === "yellow" ? "🟨" : "⬛";
  }

  function buildShareText() {
    const rows = state.guesses.map((g) =>
      ["year", "league", "division", "team", "position", "award", "debut"]
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
    lines.push(GAME_URL);
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
    resetSeasonPicker();
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

    updateRandomLockUI();

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
  await activateRound(dailyMeta.hitter, "daily");

  els.guessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (submitGuess(els.guessInput.value)) {
      els.guessInput.value = "";
      resetSeasonPicker();
      hideAutocomplete();
    }
  });

  els.guessInput.addEventListener("input", () => {
    updateSeasonPicker();
    renderAutocomplete();
  });

  els.guessInput.addEventListener("focus", renderAutocomplete);

  els.guessInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideAutocomplete();
  });

  els.autocompleteList.addEventListener("mousedown", (e) => {
    // mousedown (not click) so this fires before the input's blur handler
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    els.guessInput.value = li.textContent;
    hideAutocomplete();
    updateSeasonPicker();
    els.guessInput.focus();
  });

  document.addEventListener("click", (e) => {
    if (e.target === els.guessInput || els.autocompleteList.contains(e.target)) return;
    hideAutocomplete();
  });

  els.shareBtn.addEventListener("click", () => {
    const text = buildShareText();
    els.sharePreview.textContent = text;
    const encoded = encodeURIComponent(text);
    els.shareSmsBtn.href = `sms:&body=${encoded}`;
    els.shareEmailBtn.href = `mailto:?subject=${encodeURIComponent("Can you beat my Stat Line score?")}&body=${encoded}`;
    els.shareNativeBtn.hidden = typeof navigator.share !== "function";
    els.shareModal.hidden = false;
  });

  els.shareNativeBtn.addEventListener("click", async () => {
    try {
      await navigator.share({ text: els.sharePreview.textContent });
    } catch (e) {
      // user cancelled the native share sheet — nothing to do
    }
  });

  els.shareCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.sharePreview.textContent);
      els.shareCopyBtn.textContent = "✅ Copied!";
    } catch (e) {
      els.shareCopyBtn.textContent = "Select the text above to copy";
    }
    setTimeout(() => {
      els.shareCopyBtn.textContent = "📋 Copy to Clipboard";
    }, 2000);
  });

  els.closeShareModal.addEventListener("click", () => {
    els.shareModal.hidden = true;
  });

  els.feedbackBtn.addEventListener("click", () => {
    els.feedbackStatus.textContent = "";
    els.feedbackStatus.className = "feedback-status";
    els.feedbackModal.hidden = false;
  });

  els.closeFeedbackModal.addEventListener("click", () => {
    els.feedbackModal.hidden = true;
  });

  els.feedbackForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = els.feedbackMessage.value.trim();
    if (!message) return;
    const contact = els.feedbackContact.value.trim();

    if (!FEEDBACK_ENDPOINT) {
      const body = `${message}${contact ? `\n\nFrom: ${contact}` : ""}`;
      window.location.href = `mailto:michaelmassey13@gmail.com?subject=${encodeURIComponent(
        "Stat Line feedback"
      )}&body=${encodeURIComponent(body)}`;
      return;
    }

    const submitBtn = els.feedbackForm.querySelector("button");
    submitBtn.disabled = true;
    els.feedbackStatus.textContent = "Sending…";
    els.feedbackStatus.className = "feedback-status";
    try {
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ message, contact }),
      });
      if (!res.ok) throw new Error(`Form submission failed (${res.status})`);
      els.feedbackMessage.value = "";
      els.feedbackContact.value = "";
      els.feedbackStatus.textContent = "Thanks — feedback sent!";
      els.feedbackStatus.className = "feedback-status success";
    } catch (err) {
      els.feedbackStatus.textContent = "Couldn't send that — try again in a moment.";
      els.feedbackStatus.className = "feedback-status fail";
    } finally {
      submitBtn.disabled = false;
    }
  });

  els.statsBtn.addEventListener("click", () => {
    renderStatsModal();
    els.statsModal.hidden = false;
  });

  els.closeModal.addEventListener("click", () => {
    els.statsModal.hidden = true;
  });

  // switching stat type always drops back to that type's Daily puzzle —
  // the daily game is the priority every time, not whatever mode you were in
  els.typeHitter.addEventListener("click", () => {
    if (statType === "hitter" && roundMode === "daily") return;
    activateRound(dailyMeta.hitter, "daily");
  });

  els.typePitcher.addEventListener("click", () => {
    if (statType === "pitcher" && roundMode === "daily") return;
    activateRound(dailyMeta.pitcher, "daily");
  });

  els.modeDaily.addEventListener("click", () => {
    if (roundMode === "daily") return;
    activateRound(dailyMeta[statType], "daily");
  });

  els.modeRandom.addEventListener("click", () => {
    if (roundMode === "random") return;
    if (!isDailyDone(statType)) return;
    activateRound(randomPuzzle(statType, dailyMeta[statType].index), "random");
  });

  els.newRoundBtn.addEventListener("click", () => {
    if (!isDailyDone(statType)) return;
    if (!window.confirm("Generate a new random player? Your current practice round will be replaced.")) return;
    activateRound(randomPuzzle(statType, dailyMeta[statType].index), "random");
  });
})();
