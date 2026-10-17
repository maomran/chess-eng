import { Chess, validateFen } from './vendor/chess.js';
import { Engine } from './engine.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
const STORAGE_KEY = 'bestmove.state.v1';
const KEY_STORAGE = 'bestmove.apiKey';

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
};

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
  render();
  renderMoves();
  renderStatus();
  renderLines();
  save();
  if (state.engineOn) analyze();
}

// ---------- engine ----------

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
  engine.analyze({
    fen,
    multiPv: +$('multiPv').value,
    movetime: +$('thinkTime').value,
    onInfo: (info) => {
      if (state.analyzedFen !== fen) return;
      info.turn = turn;
      state.lines.set(info.multipv, info);
      // A deeper multipv=1 line makes stale lower lines from the previous depth misleading; drop extras.
      for (const k of state.lines.keys()) if (k > +$('multiPv').value) state.lines.delete(k);
      renderLines();
      const d = state.lines.get(1)?.depth;
      if (d) $('engineStatus').innerHTML = `<span class="spinner"></span>Depth ${d}`;
    },
    onDone: () => {
      if (state.analyzedFen !== fen) return;
      const d = state.lines.get(1)?.depth;
      $('engineStatus').textContent = d ? `Done · depth ${d}` : 'Done';
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
  if (state.tab === 'edit' || state.analyzedFen !== state.game.fen()) {
    layer.innerHTML = '';
    return;
  }
  const parts = [];
  const second = state.lines.get(2);
  if (second?.pv?.[0]) parts.push(arrowSvg(second.pv[0], 'arrow2', 'ah2', 0.12));
  const best = state.lines.get(1);
  if (best?.pv?.[0]) parts.push(arrowSvg(best.pv[0], 'arrow1', 'ah1', 0.16));
  layer.innerHTML = parts.join('');
}

function renderEvalBar() {
  const bar = $('evalBar');
  const label = $('evalLabel');
  bar.classList.toggle('flipped', state.orientation === 'b');
  const best = state.tab !== 'edit' && state.analyzedFen === state.game.fen() ? state.lines.get(1) : null;
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
  if (state.analyzedFen !== fen || state.lines.size === 0) {
    ol.innerHTML = '';
    $('playBestBtn').disabled = true;
    renderArrows();
    renderEvalBar();
    return;
  }
  const items = [...state.lines.entries()].sort((a, b) => a[0] - b[0]);
  const fullMove = +fen.split(' ')[5];
  ol.innerHTML = items.map(([k, info]) => {
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
    return `<li class="${k === 1 ? 'best' : ''}"><span class="score ${neg ? 'neg' : ''}">${s.text}</span><span class="pv">${parts.join(' ')}</span><span class="depth">d${info.depth}</span></li>`;
  }).join('');
  $('playBestBtn').disabled = !state.lines.get(1)?.pv?.[0];
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
    $('editError').textContent = '';
    updateCastlingBoxes();
    render();
    return;
  }

  const g = state.game;
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
  for (const p of ['analyze', 'edit', 'import']) $('panel-' + p).classList.toggle('hidden', p !== tab);
  if (tab === 'edit' && !wasEdit && !state.editPrepared) enterEdit();
  state.editPrepared = false;
  state.selected = null;
  state.targets = [];
  render();
}

// ---------- screenshot import ----------

let importFile = null;
let importUrl = null;

function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

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
  const key = getApiKey();
  if (!key) {
    $('keyBox').open = true;
    setImportStatus('Add your Anthropic API key below first (or set the position up by hand).', true);
    return;
  }
  $('recognizeBtn').disabled = true;
  setImportStatus('<span class="spinner"></span>Reading the board…');
  try {
    const { readBoardFromImage } = await import('./vision.js');
    const bottomHint = $('bottomSide').value;
    const res = await readBoardFromImage(importFile, key, { bottomSide: bottomHint === 'auto' ? null : bottomHint });
    const placement = res.placement
      .map((row) => row.replace(/\.+/g, (m) => String(m.length)))
      .join('/');
    let turn = $('importToMove').value;
    if (turn === 'auto') turn = res.sideToMove === 'black' ? 'b' : 'w';
    const bottom = bottomHint === 'auto' ? res.bottomSide : bottomHint;
    state.orientation = bottom === 'black' ? 'b' : 'w';

    state.edit.board = placementToMap(placement);
    $('sideToMove').value = turn;
    updateCastlingBoxes(true);
    showReference();
    state.editPrepared = true;
    switchTab('edit');
    const guessNote = res.sideToMove === 'unknown' && $('importToMove').value === 'auto'
      ? ' I couldn\'t tell whose move it is, so check “To move”.' : '';
    $('editError').textContent = '';
    setImportStatus('');
    showEditNote(`Check the position against your screenshot, fix anything that's off, then tap Done.${guessNote}${res.notes ? ' Note: ' + res.notes : ''}`);
  } catch (err) {
    console.error(err);
    let msg = err?.message || String(err);
    if (err?.status === 401) msg = 'That API key was rejected. Check it and try again.';
    else if (err?.status === 429) msg = 'Rate limited by the API. Wait a moment and try again.';
    else if (err?.status === 529 || err?.status >= 500) msg = 'The API is busy right now. Try again shortly.';
    setImportStatus(msg, true);
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
  $('playBestBtn').addEventListener('click', () => {
    const uci = state.lines.get(1)?.pv?.[0];
    if (uci) makeMove({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
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
    updateCastlingBoxes();
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
  });
  $('recognizeBtn').addEventListener('click', recognize);
  $('manualFromImgBtn').addEventListener('click', () => {
    showReference();
    switchTab('edit');
  });
  $('apiKey').value = getApiKey();
  $('keyBox').open = !getApiKey();
  $('saveKeyBtn').addEventListener('click', () => {
    try {
      localStorage.setItem(KEY_STORAGE, $('apiKey').value.trim());
      $('saveKeyBtn').textContent = 'Saved';
      setTimeout(() => { $('saveKeyBtn').textContent = 'Save'; }, 1500);
      setImportStatus('');
    } catch {
      setImportStatus('Could not save the key on this device.', true);
    }
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
