# QuizCore Multiplayer — Deployment Guide

## Project Files
```
quiz-multiplayer/
├── Code.gs              ← Google Apps Script backend (full rewrite)
├── questions_seed.csv   ← Paste into Google Sheets (unchanged format)
├── index.html           ← Frontend — host + player in one page
├── style.css            ← Styles
├── script.js            ← Game logic (set API_BASE_URL here)
└── DEPLOYMENT.md        ← This file
```

---

## Step 1 — Set Up Google Sheets

1. Go to https://sheets.google.com → create a **new spreadsheet**.
2. Rename it: `QuizCore DB`
3. Rename the first sheet tab: `Questions`
4. Add column headers in Row 1 (A → J):

| A  | B        | C        | D        | E        | F        | G              | H        | I          | J                  |
|----|----------|----------|----------|----------|----------|----------------|----------|------------|--------------------|
| id | question | option_a | option_b | option_c | option_d | correct_answer | category | difficulty | time_limit_seconds |

5. Paste rows from `questions_seed.csv` starting at Row 2.

> The `Games` and `Players` sheets are **auto-created** the first time the app runs — you don't need to create them manually.

---

## Step 2 — Set Up Google Apps Script

1. In your Sheet → **Extensions → Apps Script**.
2. Delete all existing code.
3. Paste the entire contents of `Code.gs`.
4. Click **Save**.

---

## Step 3 — Deploy as Web App

1. **Deploy → New deployment → ⚙️ Web app**
2. Settings:
   - Execute as: **Me**
   - Who has access: **Anyone**
3. Click **Deploy** → Authorize → Copy the URL.

> URL format: `https://script.google.com/macros/s/AKfycb.../exec`

---

## Step 4 — Configure the Frontend

Open `script.js`, line 5:

```js
// BEFORE
const API_BASE_URL = "YOUR_APPS_SCRIPT_URL_HERE";

// AFTER
const API_BASE_URL = "https://script.google.com/macros/s/AKfycbXXXXXXX/exec";
```

---

## Step 5 — Host the Frontend

### Option A — Local (no server needed)
Open `index.html` in any modern browser.

### Option B — GitHub Pages
Push `index.html`, `style.css`, `script.js` → Settings → Pages → main/root.

### Option C — Netlify (30 seconds)
Drag the folder to https://app.netlify.com/drop

---

## How to Play

### Host
1. Open the page → click **Host**
2. A **6-digit PIN** is generated
3. Share the PIN with players (they join on the same page)
4. Watch players appear in the lobby
5. Click **Start Game** when ready
6. During each question: see live answer count and which players answered
7. After timer or all answered: answer distribution is revealed
8. Click **Next Question** to advance (you control the pace)
9. Final leaderboard is shown at the end

### Players
1. Open the same page → click **Join**
2. Enter the PIN + your name → click **Join Game**
3. Wait in the lobby for the host
4. Answer each question before the timer runs out
5. Faster correct answers = more points (700 base + up to 300 speed bonus)
6. See your score after each answer

---

## Scoring
- **Correct answer**: 700 base + up to 300 speed bonus = max 1,000 per question
- Speed bonus formula: `300 × (timeRemaining / timeLimit)`
- Wrong or skipped: 0 points

---

## API Reference

### `?action=createGame`
Creates a game, returns PIN.

### `?action=joinGame&pin=XXXXXX&playerName=Alex`
Player joins lobby.

### `?action=hostPoll&gameId=X&hostToken=Y`
Host polls for lobby/game state. Returns `phase: lobby | question | reveal | ended`.

### `?action=playerPoll&gameId=X&playerId=Y`
Player polls for state. Returns `phase: lobby | question | waiting | reveal | ended`.

### `?action=startGame&gameId=X&hostToken=Y`
Host starts the game.

### `?action=submitAnswer&gameId=X&playerId=Y&questionId=Z&answer=A`
Player submits answer. Returns correct/wrong + points.

### `?action=nextQuestion&gameId=X&hostToken=Y`
Host advances to next question or ends the game.

---

## Notes

- Max **20 players** per game.
- All polling is **client-side** (every ~2 s) — no WebSockets needed.
- Correct answers are **never sent to players** until the reveal phase.
- The host controls the pace — players wait for "Next Question" between rounds.
- To update questions, just edit the `Questions` sheet — no redeployment needed.
- To update code, re-deploy: **Deploy → Manage deployments → Edit → New version → Deploy**.
