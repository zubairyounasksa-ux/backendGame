// ════════════════════════════════════════════════════════════
// QuizCore Multiplayer · script.js
// ════════════════════════════════════════════════════════════

const API_BASE_URL = "https://script.google.com/macros/s/AKfycbzjj1idHgeNtLPsoIu6BgnWgm53ib3VhWxVUtkUEmotxXw5Wdf8pmXxsrF5ps7Wb9V2BQ/exec";

// ── JSONP (CORS-free GET requests to Apps Script) ────────────
let _cbIdx = 0;
function jsonp(params) {
  return new Promise((resolve, reject) => {
    const cbName  = `_qcb${++_cbIdx}`;
    const timeout = setTimeout(() => {
      delete window[cbName];
      document.getElementById(`s-${cbName}`)?.remove();
      reject(new Error("Request timed out after 15 s"));
    }, 15000);

    window[cbName] = (data) => {
      clearTimeout(timeout);
      delete window[cbName];
      document.getElementById(`s-${cbName}`)?.remove();
      resolve(data);
    };

    const url = new URL(API_BASE_URL);
    url.searchParams.set("callback", cbName);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    const tag    = document.createElement("script");
    tag.id       = `s-${cbName}`;
    tag.src      = url.toString();
    tag.onerror  = () => {
      clearTimeout(timeout);
      delete window[cbName];
      tag.remove();
      reject(new Error("Network error — check your Apps Script URL"));
    };
    document.head.appendChild(tag);
  });
}

// ── State ────────────────────────────────────────────────────
const S = {
  // Role
  role:         null,   // 'host' | 'player'
  // Host fields
  gameId:       null,
  hostToken:    null,
  pin:          null,
  questionCount: 0,
  // Player fields
  playerId:     null,
  playerName:   null,
  // Shared game state
  phase:        'home',   // tracks local phase to avoid redundant redraws
  currentQIdx:  -1,
  currentQ:     null,     // { id, text, options, category, difficulty, timeLimit }
  score:        0,
  // Timers
  pollTimer:    null,
  localTimer:   null,
  localTimeLeft: 0,
};

const CIRC = 2 * Math.PI * 44; // player timer ring circumference

// ── Screen helpers ───────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function startPolling(fn, ms = 2200) {
  stopPolling();
  fn();
  S.pollTimer = setInterval(fn, ms);
}

function stopPolling() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

function startLocalTimer(seconds, onTick, onExpire) {
  stopLocalTimer();
  S.localTimeLeft = seconds;
  onTick(seconds);
  S.localTimer = setInterval(() => {
    S.localTimeLeft = Math.max(0, S.localTimeLeft - 1);
    onTick(S.localTimeLeft);
    if (S.localTimeLeft <= 0) { stopLocalTimer(); if (onExpire) onExpire(); }
  }, 1000);
}

function stopLocalTimer() {
  if (S.localTimer) { clearInterval(S.localTimer); S.localTimer = null; }
}

function showError(msg) {
  stopPolling();
  stopLocalTimer();
  document.getElementById("error-msg").textContent = msg;
  showScreen("screen-error");
}

// ── Boot ──────────────────────────────────────────────────────
document.getElementById("btn-host-mode").addEventListener("click", () => {
  S.role = 'host';
  hostCreateGame();
});
document.getElementById("btn-join-mode").addEventListener("click", () => {
  showScreen("screen-player-join");
  document.getElementById("pin-input").focus();
});
document.getElementById("btn-back-home").addEventListener("click", () => showScreen("screen-home"));
document.getElementById("btn-join").addEventListener("click", playerJoin);
document.getElementById("btn-start-game").addEventListener("click", hostStartGame);
document.getElementById("btn-next-q").addEventListener("click", hostNextQuestion);
document.getElementById("btn-end-game").addEventListener("click", hostNextQuestion);
document.getElementById("btn-play-again").addEventListener("click", () => {
  stopPolling(); stopLocalTimer();
  resetState();
  showScreen("screen-home");
});
document.getElementById("btn-err-back").addEventListener("click", () => {
  stopPolling(); stopLocalTimer();
  resetState();
  showScreen("screen-home");
});

// Enter key on join form
document.getElementById("pin-input").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("name-input").focus(); });
document.getElementById("name-input").addEventListener("keydown", e => { if (e.key === "Enter") playerJoin(); });

// Player answer buttons
document.querySelectorAll(".pq-opt").forEach(btn => {
  btn.addEventListener("click", () => playerAnswer(btn.dataset.key, btn));
});

function resetState() {
  Object.assign(S, {
    role: null, gameId: null, hostToken: null, pin: null,
    questionCount: 0, playerId: null, playerName: null,
    phase: 'home', currentQIdx: -1, currentQ: null, score: 0,
    pollTimer: null, localTimer: null, localTimeLeft: 0,
  });
}

// ═══════════════════════════════════════════════════════════
// HOST FLOWS
// ═══════════════════════════════════════════════════════════

async function hostCreateGame() {
  const btn = document.getElementById("btn-host-mode");
  btn.disabled = true;
  try {
    const data = await jsonp({ action: "createGame" });
    if (!data.success) { btn.disabled = false; showError(data.error || "Could not create game."); return; }

    S.gameId        = data.gameId;
    S.hostToken     = data.hostToken;
    S.pin           = data.pin;
    S.questionCount = data.questionCount;

    document.getElementById("host-pin-display").textContent = data.pin;
    document.getElementById("lobby-players-grid").innerHTML = "";
    document.getElementById("lobby-count").textContent = "0";
    document.getElementById("btn-start-game").disabled = true;
    document.getElementById("lobby-waiting-msg").style.display = "block";

    showScreen("screen-host-lobby");
    startPolling(pollHostLobby, 2000);
  } catch (err) {
    btn.disabled = false;
    showError(err.message);
  }
}

async function pollHostLobby() {
  try {
    const data = await jsonp({ action: "hostPoll", gameId: S.gameId, hostToken: S.hostToken });
    if (!data.success) return;

    if (data.phase === "lobby") {
      const count = data.playerCount || 0;
      document.getElementById("lobby-count").textContent = count;
      document.getElementById("btn-start-game").disabled = count < 1;

      const grid = document.getElementById("lobby-players-grid");
      const existing = new Set([...grid.querySelectorAll(".lobby-player-chip")].map(c => c.dataset.id));
      const incoming = new Set((data.players || []).map(p => p.id));

      // Add new
      (data.players || []).forEach(p => {
        if (!existing.has(p.id)) {
          const chip = document.createElement("div");
          chip.className   = "lobby-player-chip";
          chip.dataset.id  = p.id;
          chip.innerHTML   = `<div class="chip-avatar">${p.name[0].toUpperCase()}</div>${p.name}`;
          grid.appendChild(chip);
        }
      });

      // Remove left
      existing.forEach(id => {
        if (!incoming.has(id)) grid.querySelector(`[data-id="${id}"]`)?.remove();
      });

      document.getElementById("lobby-waiting-msg").style.display = count === 0 ? "block" : "none";

    } else if (data.phase !== "lobby") {
      // Game started elsewhere or ended unexpectedly — jump to game
      stopPolling();
      S.currentQIdx = data.currentQuestionIndex || 0;
      S.currentQ    = data.question;
      S.phase       = data.phase;
      showScreen("screen-host-game");
      startPolling(pollHostGame, 2000);
    }
  } catch (_) { /* silently ignore poll errors */ }
}

async function hostStartGame() {
  document.getElementById("btn-start-game").disabled = true;
  try {
    const data = await jsonp({ action: "startGame", gameId: S.gameId, hostToken: S.hostToken });
    if (!data.success) { showError(data.error || "Could not start game."); return; }
    stopPolling();
    S.phase = 'question';
    showScreen("screen-host-game");
    startPolling(pollHostGame, 2000);
  } catch (err) { showError(err.message); }
}

async function pollHostGame() {
  try {
    const data = await jsonp({ action: "hostPoll", gameId: S.gameId, hostToken: S.hostToken });
    if (!data.success) return;

    if (data.phase === "ended") {
      stopPolling();
      showFinalResults(data.leaderboard, 'host');
      return;
    }

    // New question?
    const newQuestion = data.currentQuestionIndex !== S.currentQIdx;
    if (newQuestion) {
      S.currentQIdx = data.currentQuestionIndex;
      S.currentQ    = data.question;
      renderHostQuestion(data);
      // Start local timer display
      startLocalTimer(
        data.timeRemaining,
        (t) => updateHostTimer(t, data.question.timeLimit),
        () => {}
      );
      // Hide next/end buttons
      document.getElementById("btn-next-q").style.display    = "none";
      document.getElementById("btn-end-game").style.display   = "none";
      // Hide bars
      ["a","b","c","d"].forEach(k => {
        document.getElementById(`hg-bar-${k}`).style.width    = "0%";
        document.getElementById(`hg-bar-${k}-pct`).textContent = "0%";
      });
      document.querySelectorAll(".hg-opt").forEach(el => el.classList.remove("is-correct"));
    }

    // Update answer count
    document.getElementById("hg-answered").textContent =
      `${data.answerCount} / ${data.playerCount} answered`;

    // Update mini player chips
    renderHostMiniPlayers(data.players || []);

    // Sync local timer with server (avoid drift)
    if (data.phase === "question" && Math.abs(S.localTimeLeft - data.timeRemaining) > 2) {
      startLocalTimer(data.timeRemaining, (t) => updateHostTimer(t, data.question.timeLimit), () => {});
    }

    // Reveal phase
    if (data.phase === "reveal") {
      stopLocalTimer();
      updateHostTimer(0, data.question.timeLimit);
      renderHostReveal(data);
      // Show appropriate next button
      const isLast = data.currentQuestionIndex >= data.questionCount - 1;
      document.getElementById("btn-next-q").style.display    = isLast ? "none"    : "flex";
      document.getElementById("btn-end-game").style.display   = isLast ? "flex"    : "none";
    }
  } catch (_) { /* silently ignore */ }
}

function renderHostQuestion(data) {
  const q = data.question;
  document.getElementById("hg-counter").textContent =
    `Q ${data.currentQuestionIndex + 1} / ${data.questionCount}`;
  document.getElementById("hg-category").textContent = q.category;
  document.getElementById("hg-question-text").textContent = q.text;
  document.getElementById("hg-opt-a-text").textContent = q.options.A;
  document.getElementById("hg-opt-b-text").textContent = q.options.B;
  document.getElementById("hg-opt-c-text").textContent = q.options.C;
  document.getElementById("hg-opt-d-text").textContent = q.options.D;
  document.getElementById("hg-answered").textContent = `0 / ${data.playerCount} answered`;
}

function updateHostTimer(left, total) {
  const HCIRC = 2 * Math.PI * 26; // r=26
  document.getElementById("hg-timer-num").textContent = left;
  const pct = total > 0 ? left / total : 0;
  document.getElementById("hg-timer-arc").style.strokeDashoffset = HCIRC * (1 - pct);
  document.getElementById("hg-timer-arc").classList.toggle("danger", pct < 0.35);
}

function renderHostReveal(data) {
  const dist  = data.answerDistribution || { A: 0, B: 0, C: 0, D: 0 };
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  ["A","B","C","D"].forEach(k => {
    const count = dist[k] || 0;
    const pct   = total > 0 ? Math.round(count / total * 100) : 0;
    const key   = k.toLowerCase();
    document.getElementById(`hg-bar-${key}`).style.width     = pct + "%";
    document.getElementById(`hg-bar-${key}-pct`).textContent = count + " (" + pct + "%)";
  });
  // Highlight correct answer
  if (data.correctAnswer) {
    const key = data.correctAnswer.toLowerCase();
    document.querySelector(`.hg-opt-${key}`)?.classList.add("is-correct");
  }
}

function renderHostMiniPlayers(players) {
  const wrap = document.getElementById("hg-mini-players");
  wrap.innerHTML = "";
  players.slice(0, 20).forEach(p => {
    const chip = document.createElement("div");
    chip.className = "hg-mini-chip" + (p.answered ? " answered" : "");
    chip.innerHTML = `${p.name}<span class="tick"> ✓</span>`;
    wrap.appendChild(chip);
  });
}

async function hostNextQuestion() {
  document.getElementById("btn-next-q").style.display  = "none";
  document.getElementById("btn-end-game").style.display = "none";
  try {
    const data = await jsonp({ action: "nextQuestion", gameId: S.gameId, hostToken: S.hostToken });
    if (!data.success) return;
    if (data.ended) {
      stopPolling();
      // Fetch final leaderboard
      const lb = await jsonp({ action: "hostPoll", gameId: S.gameId, hostToken: S.hostToken });
      showFinalResults(lb.leaderboard || [], 'host');
    }
    // Otherwise polling will pick up the new question state
  } catch (_) { }
}

// ═══════════════════════════════════════════════════════════
// PLAYER FLOWS
// ═══════════════════════════════════════════════════════════

async function playerJoin() {
  const pin  = document.getElementById("pin-input").value.trim();
  const name = document.getElementById("name-input").value.trim();
  const errEl = document.getElementById("join-error");

  if (!pin || pin.length !== 6) { showJoinError("Enter a 6-digit PIN."); return; }
  if (!name)                    { showJoinError("Enter your name."); return; }

  errEl.classList.add("hidden");
  document.getElementById("btn-join").disabled = true;

  try {
    const data = await jsonp({ action: "joinGame", pin, playerName: name });
    if (!data.success) { showJoinError(data.error || "Could not join game."); return; }

    S.playerId    = data.playerId;
    S.gameId      = data.gameId;
    S.playerName  = data.playerName;
    S.score       = 0;
    S.currentQIdx = -1;

    // Init lobby screen
    document.getElementById("pl-avatar").textContent = name[0].toUpperCase();
    document.getElementById("pl-name").textContent   = name;
    document.getElementById("pl-count").textContent  = "—";

    showScreen("screen-player-lobby");
    startPolling(pollPlayer, 2000);
  } catch (err) {
    showJoinError(err.message);
  }
}

function showJoinError(msg) {
  const err = document.getElementById("join-error");
  err.textContent = msg;
  err.classList.remove("hidden");
  document.getElementById("btn-join").disabled = false;
}

async function pollPlayer() {
  try {
    const data = await jsonp({ action: "playerPoll", gameId: S.gameId, playerId: S.playerId });
    if (!data.success) return;

    S.score = data.score ?? S.score;

    if (data.phase === "lobby") {
      // Still waiting — update count if available
      return;
    }

    if (data.phase === "ended") {
      stopPolling();
      stopLocalTimer();
      showFinalResults(data.leaderboard, 'player', data.rank);
      return;
    }

    // Move to quiz screen if not already there
    if (document.getElementById("screen-player-quiz").style.display === "none" ||
        !document.getElementById("screen-player-quiz").classList.contains("active")) {
      showScreen("screen-player-quiz");
    }

    // New question loaded by host?
    const newQ = data.currentQuestionIndex !== S.currentQIdx;
    if (newQ) {
      S.currentQIdx = data.currentQuestionIndex;
      S.currentQ    = data.question;
      S.phase       = 'question';
      loadPlayerQuestion(data);
      return; // loadPlayerQuestion handles the rest of the phase
    }

    // Phase updates on same question
    if (data.phase === "question" && S.phase !== "question") {
      S.phase = "question";
      setPlayerPhase("question");
    } else if (data.phase === "waiting" && S.phase === "question") {
      // Already handled by submitAnswer — but sync just in case
    } else if (data.phase === "reveal" && S.phase !== "reveal") {
      S.phase = "reveal";
      showPlayerReveal(data);
    }

  } catch (_) { /* silent */ }
}

function loadPlayerQuestion(data) {
  const q = data.question;
  // Header
  document.getElementById("pq-counter").textContent =
    `Q ${data.currentQuestionIndex + 1} / ${data.questionCount}`;
  document.getElementById("pq-score-display").textContent = S.score.toLocaleString() + " pts";
  // Progress bar
  const pct = (data.currentQuestionIndex / data.questionCount) * 100;
  document.getElementById("pq-progress").style.width = pct + "%";
  // Question text
  document.getElementById("pq-q-category").textContent = q.category;
  document.getElementById("pq-question-text").textContent = q.text;
  // Options
  document.querySelectorAll(".pq-opt").forEach(btn => {
    const key = btn.dataset.key;
    btn.querySelector(".pq-opt-txt").textContent = q.options[key] || "";
    btn.className = `pq-opt pq-opt-${key.toLowerCase()}`;
    btn.disabled  = false;
    btn.style.pointerEvents = "";
  });
  // Timer
  startLocalTimer(data.timeRemaining, updatePlayerTimer, () => {
    // Local timer expired — poll will catch reveal state
  });

  setPlayerPhase("question");
}

function setPlayerPhase(phase) {
  const questionView = document.getElementById("pq-question-view");
  const revealView   = document.getElementById("pq-reveal-view");
  const waitBanner   = document.getElementById("pq-waiting-banner");

  if (phase === "question") {
    questionView.style.display = "flex";
    revealView.classList.add("hidden");
    waitBanner.classList.add("hidden");
    document.querySelectorAll(".pq-opt").forEach(b => { b.disabled = false; b.style.pointerEvents = ""; });
  } else if (phase === "waiting") {
    questionView.style.display = "flex";
    revealView.classList.add("hidden");
    waitBanner.classList.remove("hidden");
    document.querySelectorAll(".pq-opt").forEach(b => { b.disabled = true; b.style.pointerEvents = "none"; });
  } else if (phase === "reveal") {
    questionView.style.display = "none";
    revealView.classList.remove("hidden");
  }
}

function updatePlayerTimer(left) {
  if (!S.currentQ) return;
  const total = S.currentQ.timeLimit || 20;
  document.getElementById("pq-timer-num").textContent = left;
  const pct = total > 0 ? left / total : 0;
  document.getElementById("pq-timer-arc").style.strokeDashoffset = CIRC * (1 - pct);
  document.getElementById("pq-timer-arc").classList.toggle("danger", pct < 0.35);
}

async function playerAnswer(key, btn) {
  if (S.phase !== "question") return;
  if (!S.currentQ) return;

  S.phase = "waiting";
  // Lock all options immediately
  document.querySelectorAll(".pq-opt").forEach(b => {
    b.disabled = true;
    b.style.pointerEvents = "none";
  });
  // Highlight chosen
  btn.classList.add("state-selected");
  // Show waiting banner
  document.getElementById("pq-waiting-banner").classList.remove("hidden");
  document.getElementById("pq-waiting-text").textContent = "Answer locked in — waiting for others…";

  try {
    const data = await jsonp({
      action:     "submitAnswer",
      gameId:     S.gameId,
      playerId:   S.playerId,
      questionId: S.currentQ.id,
      answer:     key,
    });

    if (data.success) {
      S.score = data.totalScore ?? S.score;
      // Patch the button with correct/wrong style
      btn.classList.remove("state-selected");
      btn.classList.add(data.correct ? "state-correct" : "state-wrong");
      if (!data.correct) {
        // Reveal which was correct
        document.querySelectorAll(".pq-opt").forEach(b => {
          if (b.dataset.key === data.correctAnswer) b.classList.add("state-reveal-correct");
        });
      }
    }
    // Wait for poll to move to reveal phase (server timer controls it)
  } catch (_) {
    // On network error just keep waiting; poll will eventually catch up
  }
}

function showPlayerReveal(data) {
  stopLocalTimer();
  setPlayerPhase("reveal");

  const myAnswer = data.myAnswer;
  const badge    = document.getElementById("pq-result-badge");
  const label    = document.getElementById("pq-result-label");
  const pts      = document.getElementById("pq-points-earned");
  const total    = document.getElementById("pq-total-score");

  if (!myAnswer) {
    // Timed out without answering
    badge.className    = "pq-result-badge wrong-badge";
    badge.textContent  = "⏱";
    label.className    = "pq-result-label timeout-lbl";
    label.textContent  = "Time's up!";
    pts.textContent    = "+0 pts";
  } else if (myAnswer.correct) {
    badge.className    = "pq-result-badge correct-badge";
    badge.textContent  = "✓";
    label.className    = "pq-result-label correct-lbl";
    label.textContent  = "Correct!";
    pts.textContent    = `+${myAnswer.points.toLocaleString()} pts`;
  } else {
    badge.className    = "pq-result-badge wrong-badge";
    badge.textContent  = "✕";
    label.className    = "pq-result-label wrong-lbl";
    label.textContent  = "Wrong!";
    pts.textContent    = "+0 pts";
  }

  total.textContent = S.score.toLocaleString();
  document.getElementById("pq-score-display").textContent = S.score.toLocaleString() + " pts";
}

// ═══════════════════════════════════════════════════════════
// SHARED RESULTS
// ═══════════════════════════════════════════════════════════

function showFinalResults(leaderboard, role, myRank) {
  stopPolling();
  stopLocalTimer();

  if (!leaderboard || !leaderboard.length) {
    showScreen("screen-results");
    document.getElementById("res-leaderboard").innerHTML =
      '<p style="color:var(--text-muted);font-size:.85rem;text-align:center">No scores yet.</p>';
    return;
  }

  const isHost = (role === 'host');
  const topScore = leaderboard[0]?.score || 0;

  // Title
  document.getElementById("res-title").textContent    = isHost ? "Final Leaderboard" : "Game Over!";
  document.getElementById("res-subtitle").textContent = isHost
    ? `${leaderboard.length} player${leaderboard.length !== 1 ? "s" : ""} competed`
    : (myRank === 1 ? "You won! 🏆" : `You finished #${myRank}`);

  // Emoji
  const emoji = isHost
    ? (leaderboard.length > 0 ? "🏆" : "📋")
    : (myRank === 1 ? "🥇" : myRank === 2 ? "🥈" : myRank === 3 ? "🥉" : "🎯");
  document.getElementById("res-podium-emoji").textContent = emoji;

  // Rows
  const wrap = document.getElementById("res-leaderboard");
  wrap.innerHTML = "";
  leaderboard.forEach((entry, i) => {
    const row   = document.createElement("div");
    const isMe  = entry.isMe || (role === 'host' ? false : entry.rank === myRank);
    const rankN = entry.rank;
    row.className = `res-row ${rankN <= 3 ? "rank-" + rankN : ""} ${isMe ? "is-me" : ""}`;

    const medal = rankN === 1 ? "🥇" : rankN === 2 ? "🥈" : rankN === 3 ? "🥉" : `#${rankN}`;
    row.innerHTML = `
      <span class="res-rank">${medal}</span>
      <span class="res-name">${entry.name}</span>
      ${isMe ? '<span class="res-me-badge">you</span>' : ''}
      <span class="res-score">${entry.score.toLocaleString()}</span>
    `;

    // Animate with delay
    row.style.opacity   = "0";
    row.style.transform = "translateX(20px)";
    wrap.appendChild(row);
    setTimeout(() => {
      row.style.transition  = "opacity .3s ease, transform .3s ease";
      row.style.opacity     = "1";
      row.style.transform   = "translateX(0)";
    }, i * 80 + 100);
  });

  showScreen("screen-results");
}
