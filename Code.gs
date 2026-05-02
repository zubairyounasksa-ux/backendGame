// ============================================================
// QuizCore Multiplayer — Google Apps Script Backend
// Deploy as: Web App → Execute as: Me → Who has access: Anyone
// ============================================================

const Q_SHEET       = "Questions";
const GAMES_SHEET   = "Games";
const PLAYERS_SHEET = "Players";
const MAX_PLAYERS   = 20;

// ── Helpers ──────────────────────────────────────────────────
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) sh.appendRow(headers);
  }
  return sh;
}

function buildResponse(data, cb) {
  const json = JSON.stringify(data);
  if (cb) {
    return ContentService
      .createTextOutput(`${cb}(${json})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Router ────────────────────────────────────────────────────
function doGet(e) {
  const p  = e.parameter || {};
  const cb = p.callback || null;
  try {
    const result = route(p.action || "", p);
    return buildResponse(result, cb);
  } catch (err) {
    return buildResponse({ error: err.message }, cb);
  }
}

function route(action, p) {
  switch (action) {
    case "createGame":    return createGame(p);
    case "joinGame":      return joinGame(p);
    case "hostPoll":      return hostPoll(p);
    case "playerPoll":    return playerPoll(p);
    case "startGame":     return startGame(p);
    case "submitAnswer":  return submitAnswer(p);
    case "nextQuestion":  return nextQuestion(p);
    default:              return { error: "Unknown action: " + action };
  }
}

// ── createGame ────────────────────────────────────────────────
// Generates a unique 6-digit PIN and initialises a Games row.
function createGame(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const gs = getOrCreateSheet(GAMES_SHEET, [
      "gameId","pin","hostToken","status","currentQIdx",
      "questionStartedAt","qCount","createdAt"
    ]);
    const qs = ss.getSheetByName(Q_SHEET);
    const qCount = qs ? Math.max(0, qs.getLastRow() - 1) : 0;
    if (!qCount) return { error: "No questions found in the Questions sheet." };

    const gameId    = Utilities.getUuid();
    const hostToken = Utilities.getUuid();

    // Guarantee unique PIN
    const existing = gs.getDataRange().getValues().slice(1).map(r => String(r[1]));
    let pin;
    do { pin = String(Math.floor(100000 + Math.random() * 900000)); }
    while (existing.includes(pin));

    gs.appendRow([gameId, pin, hostToken, "lobby", -1, "", qCount, new Date().toISOString()]);
    return { success: true, gameId, pin, hostToken, questionCount: qCount };
  } finally { lock.releaseLock(); }
}

// ── joinGame ──────────────────────────────────────────────────
function joinGame(p) {
  const pin  = String(p.pin  || "").trim();
  const name = String(p.playerName || "").trim().slice(0, 20);
  if (!pin || !name) return { error: "pin and playerName are required." };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const gs = ss.getSheetByName(GAMES_SHEET);
    if (!gs) return { error: "No active games." };

    const gRows = gs.getDataRange().getValues();
    let gameRow = null;
    for (let i = 1; i < gRows.length; i++) {
      if (String(gRows[i][1]) === pin && gRows[i][3] === "lobby") {
        gameRow = gRows[i]; break;
      }
    }
    if (!gameRow) return { error: "Game not found or already started. Check your PIN." };

    const gameId = gameRow[0];
    const ps = getOrCreateSheet(PLAYERS_SHEET, [
      "playerId","gameId","playerName","score","answers","joinedAt"
    ]);
    const pRows = ps.getDataRange().getValues();
    const inGame = pRows.slice(1).filter(r => r[1] === gameId);
    if (inGame.length >= MAX_PLAYERS) return { error: "Game is full (max " + MAX_PLAYERS + " players)." };

    const playerId = Utilities.getUuid();
    ps.appendRow([playerId, gameId, name, 0, "[]", new Date().toISOString()]);
    return { success: true, playerId, gameId, pin, playerName: name };
  } finally { lock.releaseLock(); }
}

// ── hostPoll ──────────────────────────────────────────────────
// Host polls this every ~2s to drive the lobby and in-game views.
function hostPoll(p) {
  const { gameId, hostToken } = p;
  if (!gameId || !hostToken) return { error: "gameId and hostToken required." };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const gs = ss.getSheetByName(GAMES_SHEET);
  if (!gs) return { error: "Game not found." };

  const gRows = gs.getDataRange().getValues();
  let game = null;
  for (let i = 1; i < gRows.length; i++) {
    if (gRows[i][0] === gameId && gRows[i][2] === hostToken) { game = gRows[i]; break; }
  }
  if (!game) return { error: "Game not found or invalid host token." };

  const status   = game[3];
  const curQIdx  = Number(game[4]);
  const qStarted = game[5] ? new Date(game[5]).getTime() : null;
  const qCount   = Number(game[6]);
  const pin      = game[1];

  // Load all players for this game
  const ps = ss.getSheetByName(PLAYERS_SHEET);
  const allPlayers = [];
  if (ps) {
    const pRows = ps.getDataRange().getValues();
    for (let i = 1; i < pRows.length; i++) {
      if (pRows[i][1] === gameId) {
        allPlayers.push({
          id:      pRows[i][0],
          name:    pRows[i][2],
          score:   Number(pRows[i][3]),
          answers: JSON.parse(pRows[i][4] || "[]")
        });
      }
    }
  }
  const playerCount = allPlayers.length;

  if (status === "lobby") {
    return {
      success: true, phase: "lobby", pin, questionCount: qCount,
      players:     allPlayers.map(q => ({ id: q.id, name: q.name })),
      playerCount
    };
  }

  if (status === "ended") {
    const lb = allPlayers
      .sort((a, b) => b.score - a.score)
      .map((q, i) => ({ rank: i + 1, name: q.name, score: q.score }));
    return { success: true, phase: "ended", leaderboard: lb };
  }

  // status === "active"
  const qs = ss.getSheetByName(Q_SHEET);
  if (!qs) return { error: "Questions sheet missing." };
  const qRows = qs.getDataRange().getValues();
  if (curQIdx < 0 || curQIdx >= qRows.length - 1) return { error: "Invalid question index." };

  const qRow      = qRows[curQIdx + 1];
  const timeLimit = Number(qRow[9]) || 20;
  const elapsed   = qStarted ? Math.floor((Date.now() - qStarted) / 1000) : timeLimit;
  const timeLeft  = Math.max(0, timeLimit - elapsed);
  const questionId = String(qRow[0]);
  const correctAnswer = String(qRow[6]).trim().toUpperCase();

  // Count answers for current question
  const dist = { A: 0, B: 0, C: 0, D: 0 };
  let answerCount = 0;
  allPlayers.forEach(pl => {
    const a = pl.answers.find(x => x.questionId === questionId);
    if (a) { answerCount++; if (dist[a.answer] !== undefined) dist[a.answer]++; }
  });

  const allAnswered = playerCount > 0 && answerCount === playerCount;
  const phase = (timeLeft === 0 || allAnswered) ? "reveal" : "question";

  const result = {
    success: true, phase,
    currentQuestionIndex: curQIdx, questionCount: qCount,
    timeRemaining: timeLeft, answerCount, playerCount,
    players: allPlayers.map(pl => ({
      id: pl.id, name: pl.name, score: pl.score,
      answered: pl.answers.some(x => x.questionId === questionId)
    })),
    question: {
      id: questionId, text: qRow[1],
      options: { A: qRow[2], B: qRow[3], C: qRow[4], D: qRow[5] },
      category: qRow[7] || "General",
      difficulty: qRow[8] || "Medium", timeLimit
    }
  };

  if (phase === "reveal") {
    result.correctAnswer     = correctAnswer;
    result.answerDistribution = dist;
  }
  return result;
}

// ── playerPoll ────────────────────────────────────────────────
// Players poll this to receive game state (never leaks correct answer prematurely).
function playerPoll(p) {
  const { gameId, playerId } = p;
  if (!gameId || !playerId) return { error: "gameId and playerId required." };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const gs = ss.getSheetByName(GAMES_SHEET);
  if (!gs) return { error: "Game not found." };

  const gRows = gs.getDataRange().getValues();
  let game = null;
  for (let i = 1; i < gRows.length; i++) {
    if (gRows[i][0] === gameId) { game = gRows[i]; break; }
  }
  if (!game) return { error: "Game not found." };

  const status   = game[3];
  const curQIdx  = Number(game[4]);
  const qStarted = game[5] ? new Date(game[5]).getTime() : null;
  const qCount   = Number(game[6]);

  const ps = ss.getSheetByName(PLAYERS_SHEET);
  let myAnswers = [], myScore = 0;
  if (ps) {
    const pRows = ps.getDataRange().getValues();
    for (let i = 1; i < pRows.length; i++) {
      if (pRows[i][0] === playerId) {
        myScore   = Number(pRows[i][3]);
        myAnswers = JSON.parse(pRows[i][4] || "[]");
        break;
      }
    }
  }

  if (status === "lobby") return { success: true, phase: "lobby", score: myScore };

  if (status === "ended") {
    const allPlayers = [];
    if (ps) {
      const pRows = ps.getDataRange().getValues();
      for (let i = 1; i < pRows.length; i++) {
        if (pRows[i][1] === gameId) {
          allPlayers.push({ name: pRows[i][2], score: Number(pRows[i][3]), id: pRows[i][0] });
        }
      }
    }
    const sorted = allPlayers.sort((a, b) => b.score - a.score);
    const myRank = sorted.findIndex(q => q.id === playerId) + 1;
    return {
      success: true, phase: "ended",
      score: myScore, rank: myRank,
      leaderboard: sorted.map((q, i) => ({
        rank: i + 1, name: q.name, score: q.score, isMe: q.id === playerId
      }))
    };
  }

  // Active
  const qs = ss.getSheetByName(Q_SHEET);
  if (!qs) return { error: "Questions sheet missing." };
  const qRows = qs.getDataRange().getValues();
  if (curQIdx < 0 || curQIdx >= qRows.length - 1) return { error: "Invalid question." };

  const qRow      = qRows[curQIdx + 1];
  const timeLimit = Number(qRow[9]) || 20;
  const elapsed   = qStarted ? Math.floor((Date.now() - qStarted) / 1000) : timeLimit;
  const timeLeft  = Math.max(0, timeLimit - elapsed);
  const questionId = String(qRow[0]);
  const correctAnswer = String(qRow[6]).trim().toUpperCase();

  const myAnswer     = myAnswers.find(x => x.questionId === questionId) || null;
  const timerExpired = timeLeft === 0;

  let phase;
  if      (myAnswer && !timerExpired)       phase = "waiting";
  else if (timerExpired || myAnswer)        phase = "reveal";
  else                                      phase = "question";

  const result = {
    success: true, phase,
    currentQuestionIndex: curQIdx, questionCount: qCount,
    timeRemaining: timeLeft, score: myScore,
    question: {
      id: questionId, text: qRow[1],
      options: { A: qRow[2], B: qRow[3], C: qRow[4], D: qRow[5] },
      category: qRow[7] || "General",
      difficulty: qRow[8] || "Medium", timeLimit
    }
  };
  if (phase !== "question") {
    result.myAnswer = myAnswer;
    result.correctAnswer = correctAnswer;
  }
  return result;
}

// ── startGame ─────────────────────────────────────────────────
function startGame(p) {
  const { gameId, hostToken } = p;
  if (!gameId || !hostToken) return { error: "gameId and hostToken required." };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const gs   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GAMES_SHEET);
    if (!gs) return { error: "No games." };
    const rows = gs.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === gameId && rows[i][2] === hostToken && rows[i][3] === "lobby") {
        gs.getRange(i + 1, 4).setValue("active");
        gs.getRange(i + 1, 5).setValue(0);
        gs.getRange(i + 1, 6).setValue(new Date().toISOString());
        return { success: true, currentQuestionIndex: 0 };
      }
    }
    return { error: "Game not found or not in lobby." };
  } finally { lock.releaseLock(); }
}

// ── submitAnswer ──────────────────────────────────────────────
// Points: 700 base + up to 300 speed bonus. Never reveals answer before checking.
function submitAnswer(p) {
  const { gameId, playerId, questionId, answer } = p;
  if (!gameId || !playerId || !questionId || !answer) return { error: "Missing required params." };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const qs = ss.getSheetByName(Q_SHEET);
    if (!qs) return { error: "Questions sheet missing." };
    const qRows = qs.getDataRange().getValues();
    let correctAnswer = null, timeLimit = 20;
    for (let i = 1; i < qRows.length; i++) {
      if (String(qRows[i][0]) === String(questionId)) {
        correctAnswer = String(qRows[i][6]).trim().toUpperCase();
        timeLimit     = Number(qRows[i][9]) || 20;
        break;
      }
    }
    if (!correctAnswer) return { error: "Question not found." };

    // Speed bonus
    const gs    = ss.getSheetByName(GAMES_SHEET);
    const gRows = gs.getDataRange().getValues();
    let qStarted = null;
    for (let i = 1; i < gRows.length; i++) {
      if (gRows[i][0] === gameId) { qStarted = gRows[i][5]; break; }
    }
    const elapsed   = qStarted ? (Date.now() - new Date(qStarted).getTime()) / 1000 : timeLimit;
    const timeLeft  = Math.max(0, timeLimit - elapsed);
    const isCorrect = answer.trim().toUpperCase() === correctAnswer;
    const points    = isCorrect ? Math.round(700 + 300 * (timeLeft / timeLimit)) : 0;

    const ps    = ss.getSheetByName(PLAYERS_SHEET);
    const pRows = ps.getDataRange().getValues();
    for (let i = 1; i < pRows.length; i++) {
      if (pRows[i][0] === playerId && pRows[i][1] === gameId) {
        const existing = JSON.parse(pRows[i][4] || "[]");
        if (existing.some(x => x.questionId === String(questionId))) {
          return { error: "Already answered." };
        }
        existing.push({ questionId: String(questionId), answer: answer.toUpperCase(), correct: isCorrect, points });
        const newScore = Number(pRows[i][3]) + points;
        ps.getRange(i + 1, 4).setValue(newScore);
        ps.getRange(i + 1, 5).setValue(JSON.stringify(existing));
        return { success: true, correct: isCorrect, correctAnswer, points, totalScore: newScore };
      }
    }
    return { error: "Player not found." };
  } finally { lock.releaseLock(); }
}

// ── nextQuestion ──────────────────────────────────────────────
// Host advances the game. Auto-ends when last question is passed.
function nextQuestion(p) {
  const { gameId, hostToken } = p;
  if (!gameId || !hostToken) return { error: "gameId and hostToken required." };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const gs   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GAMES_SHEET);
    const rows = gs.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === gameId && rows[i][2] === hostToken && rows[i][3] === "active") {
        const nextIdx = Number(rows[i][4]) + 1;
        const qCount  = Number(rows[i][6]);
        if (nextIdx >= qCount) {
          gs.getRange(i + 1, 4).setValue("ended");
          return { success: true, ended: true };
        }
        gs.getRange(i + 1, 5).setValue(nextIdx);
        gs.getRange(i + 1, 6).setValue(new Date().toISOString());
        return { success: true, ended: false, currentQuestionIndex: nextIdx };
      }
    }
    return { error: "Game not found or not active." };
  } finally { lock.releaseLock(); }
}
