import { Chess, validateFen } from './vendor/chess.js';
import { Engine } from './engine.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
const STORAGE_KEY = 'bestmove.state.v1';

const $ = (id) => document.getElementById(id);

// ---------- state ----------

const state = {
  tab: 'analyze',
  orientation: 'w',
  startFen: START_FEN,
  line: [],          // verbose moves from startFen
  ply: 0,            // how many moves of `line` are on the board
  game: new Chess(),
  selected: null,
  targets: [],
  engineOn: false,
  lines: new Map(),  // multipv -> info, for the position in analysis
  analyzedFen: null,
  edit: { board: {}, piece: 'wP' },
  play: { active: false, color: 'w', level: 2, over: null },
  hint: null,        // uci of a hint shown while playing
};

// Computer strength per level. Stockfish's Skill Level makes it pick weaker moves on purpose;
// the low levels also play a random move now and then so a beginner can win.
const LEVELS = [
  { skill: 0, depth: 1, random: 0.35 },
  { skill: 2, depth: 2, random: 0.15 },
  { skill: 5, depth: 4, random: 0.05 },
  { skill: 8, depth: 6, random: 0 },
  { skill: 11, depth: 8, random: 0 },
  { skill: 14, depth: 11, random: 0 },
  { skill: 17, depth: 14, random: 0 },
  { skill: 20, movetime: 2000, random: 0 },
];

let engine;
try {
  engine = new Engine();
  engine.onReady = () => {
    $('engineStatus').textContent = 'Engine ready';
    if (state.engineOn) analyze();
  };
} catch (err) {
  console.error(err);
  $('engineStatus').textContent = 'Engine failed to load';
}

// ---------- helpers ----------

function pieceSvg(code) {
  return `<svg class="piece" viewBox="0 0 40 40"><use href="vendor/pieces.svg#${code.toLowerCase()}"></use></svg>`;
}

function squareName(fileIdx, rankIdx) {
  return FILES[fileIdx] + (rankIdx + 1);
}

function placementToMap(placement) {
  const map = {};
  placement.split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      map[squareName(f, 7 - r)] = color + ch.toUpperCase();
      f++;
    }
  });
  return map;
}

function mapToPlacement(map) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = map[squareName(f, r)];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p[0] === 'w' ? p[1] : p[1].toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

function formatScore(info, turn) {
  // Engine scores are from the side to move; show them from White's side.
  const sign = turn === 'w' ? 1 : -1;
  if (info.mate !== undefined) {
    const m = info.mate * sign;
    return { text: m > 0 ? `#${m}` : `#-${Math.abs(m)}`, white: m > 0 ? 1 : -1, mate: true };
  }
  const cp = info.cp * sign;
  return { text: (cp > 0 ? '+' : '') + (cp / 100).toFixed(2), white: cp, mate: false };
}

function pvToSan(fen, pv, max = 12) {
  const g = new Chess(fen);
  const out = [];
  for (const uci of pv.slice(0, max)) {
    try {
      const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push({ san: m.san, color: m.color, moveNumber: Math.floor(out.length / 2) });
    } catch {
      break;
    }
  }
  return out;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      startFen: state.startFen,
      line: state.line.map((m) => m.san),
      ply: state.ply,
      orientation: state.orientation,
      play: state.play,
    }));
  } catch { /* storage unavailable */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) return;
    const g = new Chess(saved.startFen);
    const line = [];
    for (const san of saved.line) line.push(g.move(san));
    state.startFen = saved.startFen;
    state.line = line;
    state.ply = Math.min(saved.ply, line.length);
    state.orientation = saved.orientation === 'b' ? 'b' : 'w';
    if (saved.play) state.play = { ...state.play, ...saved.play };
  } catch {
    state.startFen = START_FEN;
    state.line = [];
    state.ply = 0;
  }
}

// ---------- position / game ----------

function rebuildGame() {
  const g = new Chess(state.startFen);
  for (let i = 0; i < state.ply; i++) g.move(state.line[i].san);
  state.game = g;
  state.selected = null;
  state.targets = [];
}

function goToPly(ply) {
  state.ply = Math.max(0, Math.min(ply, state.line.length));
  rebuildGame();
  positionChanged();
}

function loadStartFen(fen) {
  state.startFen = fen;
  state.line = [];
  state.ply = 0;
  rebuildGame();
  positionChanged();
}

function makeMove(move) {
  let m;
  try {
    m = state.game.move(move);
  } catch {
    return false;
  }
  state.line = state.line.slice(0, state.ply);
  state.line.push(m);
  state.ply++;
  state.selected = null;
  state.targets = [];
  positionChanged();
  return true;
}

function positionChanged() {
  state.lines.clear();
  state.hint = null;
  render();
  renderMoves();
  renderStatus();
  renderLines();
  renderPlay();
  save();
  if (state.engineOn) analyze();
  maybeComputerMove();
}

// ---------- engine ----------

// The i-th best line found so far (0 = best), in the engine's ranking order.
function topLine(i) {
  return [...state.lines.entries()].sort((a, b) => a[0] - b[0])[i]?.[1] ?? null;
}

// Lines to ask the engine for: the "Lines" setting, but at least 2 when the 2nd-best arrow is on.
function linesWanted() {
  return Math.max(+$('multiPv').value, $('showSecond').checked ? 2 : 1);
}

function analyze() {
  if (!engine) return;
  const g = state.game;
  if (g.isGameOver()) {
    engine.stop();
    $('engineStatus').textContent = '';
    renderLines();
    return;
  }
  const fen = g.fen();
  const turn = g.turn();
  state.analyzedFen = fen;
  state.lines.clear();
  $('engineStatus').innerHTML = engine.ready ? '<span class="spinner"></span>Thinking…' : 'Engine loading…';
  const byDepth = new Map();
  engine.analyze({
    fen,
    multiPv: linesWanted(),
    movetime: +$('thinkTime').value,
    onInfo: (info) => {
      if (state.analyzedFen !== fen) return;
      info.turn = turn;
      // Stockfish reorders its lines as it searches deeper, so mixing depths can show the same move
      // twice. Show the deepest depth that has every line (or just the deepest one so far).
      if (!byDepth.has(info.depth)) byDepth.set(info.depth, new Map());
      const atDepth = byDepth.get(info.depth);
      for (const [k, other] of atDepth) if (k !== info.multipv && other.pv[0] === info.pv[0]) atDepth.delete(k);
      atDepth.set(info.multipv, info);
      const want = linesWanted();
      const depths = [...byDepth.keys()].sort((a, b) => b - a);
      const full = depths.find((d) => byDepth.get(d).size >= want) ?? depths[0];
      state.lines = new Map([...byDepth.get(full)].filter(([k]) => k <= want));
      renderLines();
      const d = topLine(0)?.depth;
      if (d && topLine(0)?.mate === undefined) $('engineStatus').innerHTML = `<span class="spinner"></span>Depth ${d}`;
    },
    onDone: () => {
      if (state.analyzedFen !== fen) return;
      const d = topLine(0)?.depth;
      // Depth is meaningless once a forced mate is found, so leave it out then.
      const mateFound = topLine(0)?.mate !== undefined;
      $('engineStatus').textContent = d && !mateFound ? `Done · depth ${d}` : 'Done';
    },
  });
}

function setEngineOn(on) {
  state.engineOn = on;
  $('engineBtn').textContent = on ? '■ Stop' : '▶ Analyze';
  $('engineBtn').classList.toggle('primary', !on);
  if (on) {
    analyze();
  } else {
    engine?.stop();
    $('engineStatus').textContent = engine?.ready ? 'Engine ready' : 'Engine loading…';
  }
}

// ---------- rendering ----------

function render() {
  const boardEl = $('board');
  const editing = state.tab === 'edit';
  const map = editing ? state.edit.board : placementToMap(state.game.fen().split(' ')[0]);
  const last = !editing && state.ply > 0 ? state.line[state.ply - 1] : null;
  let checkSq = null;
  if (!editing && state.game.inCheck()) {
    const turn = state.game.turn();
    checkSq = Object.keys(map).find((sq) => map[sq] === turn + 'K');
  }

  const html = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const f = state.orientation === 'w' ? col : 7 - col;
      const r = state.orientation === 'w' ? 7 - row : row;
      const sq = squareName(f, r);
      const cls = ['sq', (f + r) % 2 === 0 ? 'dark' : 'light'];
      if (last && (last.from === sq || last.to === sq)) cls.push('last');
      if (state.selected === sq) cls.push('sel');
      if (state.targets.includes(sq)) cls.push('target');
      if (map[sq]) cls.push('occupied');
      if (checkSq === sq) cls.push('check');
      if (editing && state.edit.unsure?.has(sq)) cls.push('unsure');
      let inner = map[sq] ? pieceSvg(map[sq]) : '';
      if (row === 7) inner += `<span class="coord file">${FILES[f]}</span>`;
      if (col === 0) inner += `<span class="coord rank">${r + 1}</span>`;
      html.push(`<div class="${cls.join(' ')}" data-sq="${sq}">${inner}</div>`);
    }
  }
  boardEl.innerHTML = html.join('');
  renderArrows();
  renderEvalBar();
}

function squareCenter(sq) {
  const f = FILES.indexOf(sq[0]);
  const r = +sq[1] - 1;
  const x = state.orientation === 'w' ? f : 7 - f;
  const y = state.orientation === 'w' ? 7 - r : r;
  return [x + 0.5, y + 0.5];
}

function arrowSvg(uci, cls, marker, width) {
  const [x1, y1] = squareCenter(uci.slice(0, 2));
  const [x2, y2] = squareCenter(uci.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1);
  // Stop the shaft short so the arrowhead tip lands in the square centre.
  const shorten = width * 2;
  const ex = x2 - ((x2 - x1) / len) * shorten;
  const ey = y2 - ((y2 - y1) / len) * shorten;
  return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width="${width}" marker-end="url(#${marker})"></line>`;
}

function renderArrows() {
  const layer = $('arrowLayer');
  if (state.tab === 'play') {
    layer.innerHTML = state.hint ? arrowSvg(state.hint, 'arrow1', 'ah1', 0.16) : '';
    return;
  }
  const show = state.tab !== 'edit' && state.analyzedFen === state.game.fen();
  const best = show ? topLine(0)?.pv?.[0] : null;
  const second = show && $('showSecond').checked ? topLine(1)?.pv?.[0] : null;
  // Second best (black) underneath, best (green) on top.
  layer.innerHTML = (second && second !== best ? arrowSvg(second, 'arrow2', 'ah2', 0.13) : '')
    + (best ? arrowSvg(best, 'arrow1', 'ah1', 0.16) : '');
}

function renderEvalBar() {
  const bar = $('evalBar');
  const label = $('evalLabel');
  bar.classList.toggle('flipped', state.orientation === 'b');
  // No evaluation while playing: it would give the game away.
  const showEval = state.tab === 'analyze' && state.analyzedFen === state.game.fen();
  const best = showEval ? topLine(0) : null;
  let pct = 50;
  let text = '';
  const g = state.game;
  if (state.tab !== 'edit' && g.isCheckmate()) {
    pct = g.turn() === 'w' ? 0 : 100;
    text = g.turn() === 'w' ? '0-1' : '1-0';
  } else if (best) {
    const s = formatScore(best, best.turn);
    pct = s.mate ? (s.white > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.004 * s.white)) - 1);
    text = s.mate ? s.text.replace('-', '') : Math.abs(s.white / 100).toFixed(1);
  }
  $('evalWhite').style.height = `${pct}%`;
  label.textContent = text;
  // Put the label on the side that is winning.
  const whiteWinning = pct >= 50;
  const atBottom = state.orientation === 'w' ? whiteWinning : !whiteWinning;
  label.classList.toggle('top', !atBottom);
  label.style.color = whiteWinning ? '#333' : '#ddd';
}

function renderLines() {
  const ol = $('lines');
  const fen = state.game.fen();
  const bestEl = $('bestMove');
  if (state.analyzedFen !== fen || state.lines.size === 0) {
    ol.innerHTML = '';
    bestEl.classList.add('hidden');
    $('playBestBtn').disabled = true;
    renderArrows();
    renderEvalBar();
    return;
  }
  const items = [...state.lines.entries()].sort((a, b) => a[0] - b[0]);
  const fullMove = +fen.split(' ')[5];
  ol.innerHTML = items.map(([, info], idx) => {
    const s = formatScore(info, info.turn);
    const sans = pvToSan(fen, info.pv);
    const parts = sans.map((m, i) => {
      const num = fullMove + Math.floor((i + (info.turn === 'b' ? 1 : 0)) / 2);
      let prefix = '';
      if (m.color === 'w') prefix = `${num}. `;
      else if (i === 0) prefix = `${num}… `;
      return i === 0 ? `${prefix}<b>${m.san}</b>` : prefix + m.san;
    });
    const neg = s.white < 0;
    return `<li class="${idx === 0 ? 'best' : ''}"><span class="score ${neg ? 'neg' : ''}">${s.text}</span><span class="pv">${parts.join(' ')}</span><span class="depth">${info.mate === undefined ? 'd' + info.depth : ''}</span></li>`;
  }).join('');
  const best = topLine(0);
  const bestSan = best?.pv?.[0] ? pvToSan(fen, best.pv, 1)[0]?.san : null;
  bestEl.classList.toggle('hidden', !bestSan);
  if (bestSan) {
    const side = best.turn === 'w' ? 'White' : 'Black';
    let verdict = formatScore(best, best.turn).text;
    if (best.mate > 0) verdict = `Mate in ${best.mate}`;
    else if (best.mate < 0) verdict = `Gets mated in ${-best.mate}`;
    else if (best.mate === 0) verdict = 'Mated';
    bestEl.innerHTML = `<span class="label"><span class="key" style="background:rgba(21,120,27,.85)"></span>Best move for ${side}</span><span class="san">${bestSan}</span><span class="score">${verdict}</span>`;
    const second = $('showSecond').checked ? topLine(1) : null;
    const secondSan = second?.pv?.[0] ? pvToSan(fen, second.pv, 1)[0]?.san : null;
    if (secondSan) {
      bestEl.innerHTML += `<span class="second"><span class="key" style="background:rgba(0,0,0,.62);outline:1px solid #777"></span>2nd best: <b>${secondSan}</b> (${formatScore(second, second.turn).text})</span>`;
    }
  }
  $('playBestBtn').disabled = !bestSan;
  renderArrows();
  renderEvalBar();
}

function renderMoves() {
  const el = $('moves');
  if (!state.line.length) {
    el.innerHTML = '<span class="muted">No moves yet. Tap a piece to move it.</span>';
  } else {
    const startFull = +state.startFen.split(' ')[5] || 1;
    const blackFirst = state.startFen.split(' ')[1] === 'b';
    const out = [];
    state.line.forEach((m, i) => {
      const idx = i + (blackFirst ? 1 : 0);
      const num = startFull + Math.floor(idx / 2);
      if (m.color === 'w') out.push(`<span class="num">${num}.</span>`);
      else if (i === 0) out.push(`<span class="num">${num}…</span>`);
      out.push(`<span class="mv ${i === state.ply - 1 ? 'cur' : ''}" data-ply="${i + 1}">${m.san}</span>`);
    });
    el.innerHTML = out.join(' ');
    el.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
  $('undoBtn').disabled = state.ply === 0;
  $('redoBtn').disabled = state.ply >= state.line.length;
}

// Flips whose turn it is in the current position (for when a screenshot or setup got it wrong).
function switchTurn() {
  const parts = state.game.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const fen = parts.join(' ');
  const err = validatePosition(fen);
  if (err) {
    $('gameStatus').textContent = err;
    return;
  }
  loadStartFen(fen);
}

function renderStatus() {
  const g = state.game;
  const el = $('gameStatus');
  let text = '';
  if (g.isCheckmate()) text = `Checkmate — ${g.turn() === 'w' ? 'Black' : 'White'} wins.`;
  else if (g.isStalemate()) text = 'Stalemate — draw.';
  else if (g.isInsufficientMaterial()) text = 'Draw — insufficient material.';
  else if (g.isThreefoldRepetition()) text = 'Draw — threefold repetition.';
  else if (g.isDraw()) text = 'Draw — 50-move rule.';
  else text = `${g.turn() === 'w' ? 'White' : 'Black'} to move${g.inCheck() ? ' (in check)' : ''}.`;
  el.textContent = text;
  $('switchTurnBtn').classList.toggle('hidden', g.isGameOver());
}

// ---------- board input ----------

function choosePromotion(color) {
  return new Promise((resolve) => {
    const modal = $('promoModal');
    const box = $('promoChoices');
    box.innerHTML = ['q', 'r', 'b', 'n']
      .map((p) => `<button data-p="${p}">${pieceSvg(color + p.toUpperCase())}</button>`)
      .join('');
    modal.classList.remove('hidden');
    const done = (e) => {
      const btn = e.target.closest('button');
      modal.classList.add('hidden');
      modal.removeEventListener('click', done);
      resolve(btn ? btn.dataset.p : null);
    };
    modal.addEventListener('click', done);
  });
}

async function onSquareTap(sq) {
  if (state.tab === 'edit') {
    const b = state.edit.board;
    const p = state.edit.piece;
    if (p === 'x' || b[sq] === p) delete b[sq];
    else b[sq] = p;
    state.edit.unsure?.delete(sq);
    $('editError').textContent = '';
    updateCastlingBoxes();
    render();
    return;
  }

  const g = state.game;
  if (isPlaying() && g.turn() !== state.play.color) return;
  if (state.selected && state.targets.includes(sq)) {
    const from = state.selected;
    const options = g.moves({ square: from, verbose: true }).filter((m) => m.to === sq);
    let promotion;
    if (options.some((m) => m.promotion)) {
      promotion = await choosePromotion(g.turn());
      if (!promotion) {
        state.selected = null;
        state.targets = [];
        render();
        return;
      }
    }
    makeMove({ from, to: sq, promotion });
    return;
  }
  const piece = g.get(sq);
  if (piece && piece.color === g.turn() && state.selected !== sq) {
    state.selected = sq;
    state.targets = g.moves({ square: sq, verbose: true }).map((m) => m.to);
  } else {
    state.selected = null;
    state.targets = [];
  }
  render();
}

// ---------- edit mode ----------

const CASTLE_REQ = {
  K: [['e1', 'wK'], ['h1', 'wR']],
  Q: [['e1', 'wK'], ['a1', 'wR']],
  k: [['e8', 'bK'], ['h8', 'bR']],
  q: [['e8', 'bK'], ['a8', 'bR']],
};

function updateCastlingBoxes(autoCheck = false) {
  for (const [flag, reqs] of Object.entries(CASTLE_REQ)) {
    const box = $('c' + flag);
    const possible = reqs.every(([sq, p]) => state.edit.board[sq] === p);
    if (!possible) box.checked = false;
    else if (box.disabled || autoCheck) box.checked = true;
    box.disabled = !possible;
  }
}

function editFen() {
  let castling = ['K', 'Q', 'k', 'q'].filter((f) => $('c' + f).checked && !$('c' + f).disabled).join('');
  return `${mapToPlacement(state.edit.board)} ${$('sideToMove').value} ${castling || '-'} - 0 1`;
}

function validatePosition(fen) {
  const v = validateFen(fen);
  if (!v.ok) return v.error;
  const map = placementToMap(fen.split(' ')[0]);
  const pieces = Object.values(map);
  if (pieces.filter((p) => p === 'wK').length !== 1) return 'White needs exactly one king.';
  if (pieces.filter((p) => p === 'bK').length !== 1) return 'Black needs exactly one king.';
  for (const [sq, p] of Object.entries(map)) {
    if (p[1] === 'P' && (sq[1] === '1' || sq[1] === '8')) return `Pawns can't stand on the first or last rank (${sq}).`;
  }
  let g;
  try {
    g = new Chess(fen);
  } catch (e) {
    return e.message;
  }
  const turn = g.turn();
  const other = turn === 'w' ? 'b' : 'w';
  const otherKing = Object.keys(map).find((sq) => map[sq] === other + 'K');
  if (g.isAttacked(otherKing, turn)) {
    return `${other === 'w' ? 'White' : 'Black'} is in check but it's ${turn === 'w' ? 'White' : 'Black'}'s move. Change who is to move.`;
  }
  return null;
}

function enterEdit(fromFen) {
  const fen = fromFen || state.game.fen();
  state.edit.unsure = null;
  const [placement, turn, castling] = fen.split(' ');
  state.edit.board = placementToMap(placement);
  $('sideToMove').value = turn;
  for (const f of ['K', 'Q', 'k', 'q']) $('c' + f).checked = castling.includes(f);
  updateCastlingBoxes();
  // Keep the boxes that were set in the FEN; updateCastlingBoxes only clears impossible ones.
  for (const f of ['K', 'Q', 'k', 'q']) if (!$('c' + f).disabled) $('c' + f).checked = castling.includes(f);
}

function finishEdit() {
  const fen = editFen();
  const err = validatePosition(fen);
  if (err) {
    $('editError').textContent = err;
    return;
  }
  $('editError').textContent = '';
  loadStartFen(new Chess(fen).fen());
  switchTab('analyze');
  setEngineOn(true);
}

function buildPalette() {
  const codes = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'x', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
  const el = $('palette');
  el.innerHTML = codes.map((c) => c === 'x'
    ? '<button data-p="x" class="erase" title="Eraser" aria-label="Eraser">⌫</button>'
    : `<button data-p="${c}" aria-label="${c}">${pieceSvg(c)}</button>`).join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.edit.piece = btn.dataset.p;
    markPalette();
  });
  markPalette();
}

function markPalette() {
  for (const b of $('palette').querySelectorAll('button')) b.classList.toggle('on', b.dataset.p === state.edit.piece);
}

// ---------- tabs ----------

function switchTab(tab) {
  const wasEdit = state.tab === 'edit';
  state.tab = tab;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  for (const p of ['analyze', 'play', 'edit', 'import']) $('panel-' + p).classList.toggle('hidden', p !== tab);
  if (tab === 'play') {
    setEngineOn(false);
    state.hint = null;
  }
  if (tab === 'edit' && !wasEdit && !state.editPrepared) enterEdit();
  state.editPrepared = false;
  state.selected = null;
  state.targets = [];
  render();
  renderPlay();
  maybeComputerMove();
}

// ---------- play vs computer ----------

let computerJob = 0;

function isPlaying() {
  return state.tab === 'play' && state.play.active && !state.play.over;
}

function startGame(fromCurrent) {
  const pick = $('playColor').value;
  const color = pick === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;
  state.play = { active: true, color, level: +$('level').value, over: null };
  state.orientation = color;
  if (fromCurrent) loadStartFen(state.game.fen());
  else loadStartFen(START_FEN);
}

function maybeComputerMove() {
  const g = state.game;
  if (!isPlaying() || !engine) return;
  if (g.isGameOver()) {
    state.play.over = 'end';
    renderPlay();
    save();
    return;
  }
  if (g.turn() === state.play.color) return;

  const job = ++computerJob;
  const fen = g.fen();
  const level = LEVELS[state.play.level] || LEVELS[2];
  const started = Date.now();
  const play = (uci) => {
    // Short pause so the reply doesn't feel instant at low levels.
    setTimeout(() => {
      if (job !== computerJob || !isPlaying() || state.game.fen() !== fen) return;
      makeMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    }, Math.max(0, 500 - (Date.now() - started)));
  };
  renderPlay(true);

  if (Math.random() < level.random) {
    const moves = g.moves({ verbose: true });
    const m = moves[Math.floor(Math.random() * moves.length)];
    play(m.from + m.to + (m.promotion || ''));
    return;
  }
  engine.analyze({
    fen,
    skill: level.skill,
    depth: level.depth,
    movetime: level.movetime,
    onInfo() {},
    onDone: (uci) => {
      if (uci && uci !== '(none)') play(uci);
    },
  });
}

function showHint() {
  if (!isPlaying() || !engine || state.game.turn() !== state.play.color) return;
  const fen = state.game.fen();
  $('hintBtn').disabled = true;
  engine.analyze({
    fen,
    movetime: 1500,
    onInfo() {},
    onDone: (uci) => {
      $('hintBtn').disabled = false;
      if (state.game.fen() !== fen || !uci || uci === '(none)') return;
      state.hint = uci;
      renderArrows();
    },
  });
}

function takeBack() {
  if (!state.play.active) return;
  computerJob++;
  engine?.stop();
  state.play.over = null;
  // Go back to the last position where it was the player's turn.
  let ply = state.ply - 1;
  const g = new Chess(state.startFen);
  const turns = [g.turn()];
  for (const m of state.line) { g.move(m.san); turns.push(g.turn()); }
  while (ply > 0 && turns[ply] !== state.play.color) ply--;
  if (ply < 0 || turns[ply] !== state.play.color) return;
  state.line = state.line.slice(0, ply);
  goToPly(ply);
}

function resign() {
  if (!isPlaying()) return;
  computerJob++;
  engine?.stop();
  state.play.over = 'resigned';
  renderPlay();
  save();
}

function renderPlay(thinking = false) {
  const el = $('playStatus');
  const g = state.game;
  const p = state.play;
  $('playControls').classList.toggle('hidden', !p.active || !!p.over);
  $('level').value = String(p.level);
  if (!p.active) {
    el.textContent = 'Pick a level and your color, then start a game.';
    return;
  }
  const you = p.color;
  let text;
  if (p.over === 'resigned') text = 'You resigned. Start a new game to play again.';
  else if (g.isCheckmate()) text = g.turn() === you ? 'Checkmate — the computer wins.' : 'Checkmate — you win! 🎉';
  else if (g.isGameOver()) text = 'Draw.';
  else if (thinking || g.turn() !== you) text = '<span class="spinner"></span>Computer is thinking…';
  else text = `Your move${g.inCheck() ? ' — you are in check!' : '.'}`;
  el.innerHTML = text;
  $('takebackBtn').disabled = state.ply === 0;
  $('hintBtn').disabled = g.turn() !== you;
}

// ---------- screenshot import ----------

let importFile = null;
let importUrl = null;

function setImportStatus(text, isError = false) {
  const el = $('importStatus');
  el.innerHTML = text;
  el.classList.toggle('error', isError);
}

function showReference() {
  $('refImageWrap').classList.toggle('hidden', !importUrl);
  if (importUrl) $('refImage').src = importUrl;
}

async function recognize() {
  if (!importFile) return;
  $('recognizeBtn').disabled = true;
  setImportStatus('<span class="spinner"></span>Reading the board…');
  try {
    const { recognize: readImage } = await import('./recognizer.js');
    const bottomHint = $('bottomSide').value;
    const res = await readImage(importFile, { bottomHint: bottomHint === 'auto' ? null : bottomHint });
    const placement = res.ranks
      .map((row) => row.replace(/\.+/g, (m) => String(m.length)))
      .join('/');
    let turn = $('importToMove').value;
    // A screenshot rarely shows whose move it is; assume the player at the bottom (usually you).
    if (turn === 'auto') turn = res.bottom[0];
    state.orientation = res.bottom === 'black' ? 'b' : 'w';

    state.edit.board = placementToMap(placement);
    state.edit.unsure = new Set(res.unsure);
    $('sideToMove').value = turn;
    updateCastlingBoxes(true);
    showReference();
    state.editPrepared = true;
    switchTab('edit');
    $('editError').textContent = '';
    setImportStatus('');
    let note = `Check the position against your screenshot, fix anything that's off, then tap Done. I assumed ${turn === 'w' ? 'White' : 'Black'} is to move — change “To move” if not.`;
    if (res.unsure.length) note += ` Squares outlined in yellow were hard to read: ${res.unsure.join(', ')}.`;
    showEditNote(note);
  } catch (err) {
    console.error(err);
    setImportStatus(err?.message || String(err), true);
    $('manualFromImgBtn').classList.remove('hidden');
  } finally {
    $('recognizeBtn').disabled = !importFile;
  }
}

function showEditNote(text) {
  let note = $('editNote');
  if (!note) {
    note = document.createElement('p');
    note.id = 'editNote';
    note.className = 'status';
    $('panel-edit').prepend(note);
  }
  note.textContent = text;
}

// ---------- wiring ----------

function wire() {
  $('board').addEventListener('click', (e) => {
    const sqEl = e.target.closest('.sq');
    if (sqEl) onSquareTap(sqEl.dataset.sq);
  });
  $('flipBtn').addEventListener('click', () => {
    state.orientation = state.orientation === 'w' ? 'b' : 'w';
    save();
    render();
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));

  $('engineBtn').addEventListener('click', () => setEngineOn(!state.engineOn));
  $('thinkTime').addEventListener('change', () => state.engineOn && analyze());
  $('multiPv').addEventListener('change', () => state.engineOn && analyze());
  $('showSecond').addEventListener('change', () => {
    if (state.engineOn) analyze();
    else renderLines();
  });
  $('playBestBtn').addEventListener('click', () => {
    const uci = topLine(0)?.pv?.[0];
    if (uci) makeMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  });
  $('switchTurnBtn').addEventListener('click', switchTurn);
  $('newPlayBtn').addEventListener('click', () => startGame(false));
  $('playFromHereBtn').addEventListener('click', () => startGame(true));
  $('hintBtn').addEventListener('click', showHint);
  $('takebackBtn').addEventListener('click', takeBack);
  $('resignBtn').addEventListener('click', resign);
  $('level').addEventListener('change', () => {
    state.play.level = +$('level').value;
    save();
  });
  $('undoBtn').addEventListener('click', () => goToPly(state.ply - 1));
  $('redoBtn').addEventListener('click', () => goToPly(state.ply + 1));
  $('moves').addEventListener('click', (e) => {
    const mv = e.target.closest('.mv');
    if (mv) goToPly(+mv.dataset.ply);
  });
  $('newGameBtn').addEventListener('click', () => loadStartFen(START_FEN));
  $('copyFenBtn').addEventListener('click', async () => {
    const fen = state.game.fen();
    try {
      await navigator.clipboard.writeText(fen);
      $('copyFenBtn').textContent = 'Copied!';
    } catch {
      prompt('FEN', fen);
    }
    setTimeout(() => { $('copyFenBtn').textContent = 'Copy FEN'; }, 1500);
  });

  $('startPosBtn').addEventListener('click', () => {
    enterEdit(START_FEN);
    render();
  });
  $('clearBtn').addEventListener('click', () => {
    state.edit.board = {};
    state.edit.unsure = null;
    updateCastlingBoxes();
    render();
  });
  $('rotateBtn').addEventListener('click', () => {
    // Turns the position around (a1 <-> h8), for screenshots read from the wrong side.
    const rot = (sq) => 'abcdefgh'[7 - 'abcdefgh'.indexOf(sq[0])] + (9 - +sq[1]);
    const b = {};
    for (const [sq, p] of Object.entries(state.edit.board)) b[rot(sq)] = p;
    state.edit.board = b;
    if (state.edit.unsure) state.edit.unsure = new Set([...state.edit.unsure].map(rot));
    state.orientation = state.orientation === 'w' ? 'b' : 'w';
    updateCastlingBoxes(true);
    $('editError').textContent = '';
    render();
  });
  $('loadFenBtn').addEventListener('click', () => {
    const fen = $('fenInput').value.trim();
    const full = fen.split(/\s+/).length === 1 ? `${fen} w - - 0 1` : fen;
    const err = validatePosition(full);
    if (err) {
      $('editError').textContent = err;
      return;
    }
    enterEdit(new Chess(full).fen());
    $('editError').textContent = '';
    render();
  });
  $('sideToMove').addEventListener('change', () => { $('editError').textContent = ''; });
  $('doneEditBtn').addEventListener('click', finishEdit);

  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importFile = file;
    if (importUrl) URL.revokeObjectURL(importUrl);
    importUrl = URL.createObjectURL(file);
    $('previewImg').src = importUrl;
    $('previewImg').classList.remove('hidden');
    $('recognizeBtn').disabled = false;
    $('manualFromImgBtn').classList.remove('hidden');
    setImportStatus('');
    recognize();
  });
  $('recognizeBtn').addEventListener('click', recognize);
  $('manualFromImgBtn').addEventListener('click', () => {
    showReference();
    switchTab('edit');
  });
}

restore();
rebuildGame();
buildPalette();
wire();
positionChanged();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
