// Draws random synthetic chess screenshots and turns them into training samples
// with the same feature code the app uses (recognizer.js).
import { Chess } from '../../vendor/chess.js';
import { detectBoard, squareFeatures, FEAT, CLASSES } from '../../recognizer.js';

const CODES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];
const GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const OUTLINE = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
const PALETTES = [
  ['#eeeed2', '#769656'], ['#ebecd0', '#739552'], ['#f0d9b5', '#b58863'], ['#dee3e6', '#8ca2ad'],
  ['#f0d9b5', '#946f51'], ['#e8edf9', '#b7c0d8'], ['#ebecd0', '#4b7399'], ['#eae9d2', '#4b7399'],
  ['#f3f3f4', '#6a9b41'], ['#d9d9d9', '#a6a6a6'], ['#ffffdd', '#86a666'], ['#cecece', '#717171'],
  ['#e4c294', '#a67c52'], ['#fbe4c0', '#c3956b'], ['#efefef', '#8877b7'], ['#dfe8ee', '#7d9cb2'],
];
const HIGHLIGHTS = ['rgba(255,255,51,0.5)', 'rgba(155,199,0,0.41)', 'rgba(20,85,30,0.5)', 'rgba(246,246,105,0.8)', 'rgba(255,170,0,0.45)', 'rgba(130,150,255,0.45)'];

let rngState = 1;
export function seed(s) { rngState = s >>> 0 || 1; }
function rnd() { rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5; return (rngState >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const range = (a, b) => a + rnd() * (b - a);

const cache = {};
async function loadSet(name) {
  if (cache[name]) return cache[name];
  if (name.startsWith('font:')) return (cache[name] = { font: name.slice(5) });
  const imgs = {};
  await Promise.all(CODES.map(async (c) => {
    for (const ext of ['svg', 'png']) {
      const url = `../../../pieces/${name}/${c}.${ext}`;
      const ok = await fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
      if (!ok) continue;
      const img = new Image();
      img.src = url;
      await img.decode();
      imgs[c] = img;
      return;
    }
    throw new Error(`missing ${name}/${c}`);
  }));
  return (cache[name] = { imgs });
}

function randomColor(light) {
  const h = range(0, 360), s = range(0, light ? 30 : 45), l = light ? range(78, 96) : range(35, 66);
  return `hsl(${h},${s}%,${l}%)`;
}

let lastWasGame = false;
function randomPosition() {
  const r = rnd();
  lastWasGame = r < 0.75;
  if (r < 0.1) return new Chess().board();
  if (r < 0.75) {
    const g = new Chess();
    const plies = Math.floor(range(2, 90));
    for (let i = 0; i < plies && !g.isGameOver(); i++) {
      const moves = g.moves({ verbose: true });
      const caps = moves.filter((m) => m.captured);
      g.move(caps.length && rnd() < 0.4 ? pick(caps) : pick(moves));
    }
    return g.board();
  }
  // sparse random placement (endgames, puzzles); also exercises unusual squares
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const put = (type, color) => {
    for (let t = 0; t < 50; t++) {
      const r = Math.floor(rnd() * 8), c = Math.floor(rnd() * 8);
      if (board[r][c] || (type === 'p' && (r === 0 || r === 7))) continue;
      board[r][c] = { type, color };
      return;
    }
  };
  put('k', 'w'); put('k', 'b');
  const n = Math.floor(range(0, 14));
  for (let i = 0; i < n; i++) put(pick(['p', 'p', 'p', 'n', 'b', 'r', 'q']), pick(['w', 'b']));
  return board;
}

function drawPiece(ctx, set, code, x, y, s) {
  const k = range(0.78, 1.0);
  const size = s * k;
  const jx = range(-0.03, 0.03) * s, jy = range(-0.03, 0.03) * s;
  const cx = x + s / 2 + jx, cy = y + s / 2 + jy;
  if (set.font) {
    ctx.save();
    ctx.font = `${size * 0.9}px "${set.font}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const t = code[1];
    if (code[0] === 'w') {
      ctx.fillStyle = `hsl(0,0%,${range(88, 100)}%)`;
      ctx.fillText(GLYPH[t], cx, cy);
      ctx.fillStyle = '#000';
      ctx.fillText(OUTLINE[t], cx, cy);
    } else {
      ctx.fillStyle = `hsl(0,0%,${range(0, 18)}%)`;
      ctx.fillText(GLYPH[t], cx, cy);
    }
    ctx.restore();
    return;
  }
  ctx.save();
  if (rnd() < 0.25) {
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = s * 0.05;
    ctx.shadowOffsetY = s * 0.03;
  }
  ctx.drawImage(set.imgs[code], cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}

// Analysis arrows like lichess / chess.com draw them, on top of the pieces.
function arrows(ctx, bx, by, s) {
  const n = Math.floor(range(1, 4));
  const color = pick(['rgba(21,120,27,0.8)', 'rgba(0,48,136,0.6)', 'rgba(136,32,32,0.75)', 'rgba(230,143,0,0.8)', 'rgba(255,170,0,0.75)', 'rgba(70,160,60,0.7)']);
  for (let i = 0; i < n; i++) {
    const fx = Math.floor(rnd() * 8), fy = Math.floor(rnd() * 8);
    let tx = fx + Math.floor(range(-3, 4)), ty = fy + Math.floor(range(-3, 4));
    tx = Math.max(0, Math.min(7, tx)); ty = Math.max(0, Math.min(7, ty));
    if (tx === fx && ty === fy) continue;
    const x1 = bx + (fx + 0.5) * s, y1 = by + (fy + 0.5) * s, x2 = bx + (tx + 0.5) * s, y2 = by + (ty + 0.5) * s;
    const w = s * range(0.12, 0.22);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = w * 2.2;
    const ex = x2 - Math.cos(ang) * head, ey = y2 - Math.sin(ang) * head;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(ex + Math.cos(ang + Math.PI / 2) * w * 1.5, ey + Math.sin(ang + Math.PI / 2) * w * 1.5);
    ctx.lineTo(ex + Math.cos(ang - Math.PI / 2) * w * 1.5, ey + Math.sin(ang - Math.PI / 2) * w * 1.5);
    ctx.fill();
    ctx.restore();
  }
}

function clutter(ctx, W, H, bx, by, bs) {
  const n = Math.floor(range(2, 9));
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rnd() < 0.5 ? randomColor(rnd() < 0.5) : `hsl(0,0%,${range(5, 40)}%)`;
    const w = range(20, W * 0.8), h = range(10, H * 0.15);
    const x = range(0, W - w);
    const y = rnd() < 0.5 ? range(0, Math.max(1, by - h)) : range(Math.min(H - 1, by + bs), H);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = rnd() < 0.5 ? '#fff' : '#111';
    ctx.font = `${Math.floor(range(10, 28))}px sans-serif`;
    ctx.fillText(pick(['Magnus (2850)', '10:00', 'Opponent', 'You', '1. e4 e5 2. Nf3', 'Analysis', 'Best move', '+1.2', '♟ 3']), x + 4, y + h / 2 + 6);
  }
}

// Returns { canvas, board: {x,y,size}, labels: CLASSES index per image square (row 0 = top) }
export async function makeScreenshot(sets) {
  const W = Math.round(range(360, 1100));
  const H = Math.round(W * range(0.75, 2.2));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = rnd() < 0.6 ? `hsl(${range(0, 360)},${range(0, 15)}%,${range(8, 25)}%)` : randomColor(true);
  ctx.fillRect(0, 0, W, H);

  const maxB = Math.min(W, H);
  const bs = Math.round(maxB * (rnd() < 0.6 ? range(0.92, 1.0) : range(0.35, 0.92)));
  const bx = Math.round(range(0, W - bs));
  const by = Math.round(range(0, H - bs));
  clutter(ctx, W, H, bx, by, bs);

  const [light, dark] = rnd() < 0.8 ? pick(PALETTES) : [randomColor(true), randomColor(false)];
  const s = bs / 8;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    ctx.fillStyle = (r + c) % 2 ? dark : light;
    ctx.fillRect(Math.round(bx + c * s), Math.round(by + r * s), Math.ceil(s), Math.ceil(s));
  }
  if (rnd() < 0.15) { // texture
    for (let i = 0; i < 400; i++) {
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${range(0.02, 0.06)})`;
      ctx.beginPath(); const yy = range(by, by + bs); ctx.moveTo(bx, yy); ctx.lineTo(bx + bs, yy + range(-10, 10)); ctx.stroke();
    }
  }
  const highlightColor = pick(HIGHLIGHTS);
  const nh = rnd() < 0.7 ? 2 : Math.floor(range(0, 4));
  for (let i = 0; i < nh; i++) {
    ctx.fillStyle = highlightColor;
    ctx.fillRect(bx + Math.floor(rnd() * 8) * s, by + Math.floor(rnd() * 8) * s, s, s);
  }

  const flipped = rnd() < 0.35;
  const coords = rnd();
  if (coords < 0.6) {
    ctx.font = `bold ${Math.max(8, s * range(0.16, 0.24))}px sans-serif`;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = (7 + i) % 2 ? light : dark;
      ctx.fillText('abcdefgh'[flipped ? 7 - i : i], bx + i * s + s * 0.8, by + 8 * s - s * 0.06);
      ctx.fillStyle = i % 2 ? light : dark;
      ctx.fillText(String(flipped ? i + 1 : 8 - i), bx + s * 0.05, by + i * s + s * 0.22);
    }
  }

  const setName = pick(sets);
  const set = await loadSet(setName);
  const pos = randomPosition();
  const isGame = lastWasGame;
  const labels = new Array(64).fill(0);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = pos[r][c];
    const ir = flipped ? 7 - r : r, ic = flipped ? 7 - c : c;
    if (!p) {
      if (rnd() < 0.03) { // move-hint dot on an empty square
        ctx.fillStyle = 'rgba(0,0,0,0.14)';
        ctx.beginPath(); ctx.arc(bx + ic * s + s / 2, by + ir * s + s / 2, s * 0.16, 0, 7); ctx.fill();
      }
      continue;
    }
    const code = p.color + p.type.toUpperCase();
    if (p.type === 'k' && rnd() < 0.06) { // "in check" glow
      const g = ctx.createRadialGradient(bx + ic * s + s / 2, by + ir * s + s / 2, 0, bx + ic * s + s / 2, by + ir * s + s / 2, s * 0.6);
      g.addColorStop(0, 'rgba(255,0,0,1)'); g.addColorStop(0.3, 'rgba(231,0,0,1)'); g.addColorStop(1, 'rgba(169,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(bx + ic * s, by + ir * s, s, s);
    }
    drawPiece(ctx, set, code, bx + ic * s, by + ir * s, s);
    labels[ir * 8 + ic] = CLASSES.indexOf(p.color === 'w' ? p.type.toUpperCase() : p.type);
  }

  if (rnd() < 0.4) arrows(ctx, bx, by, s);

  // Degrade: rescale and/or JPEG
  let out = canvas;
  if (rnd() < 0.5) {
    const f = range(0.5, 0.95);
    const c2 = document.createElement('canvas');
    c2.width = Math.round(W * f); c2.height = Math.round(H * f);
    c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
    out = c2;
  }
  if (rnd() < 0.5) {
    const img = new Image();
    img.src = out.toDataURL('image/jpeg', range(0.5, 0.95));
    await img.decode();
    const c3 = document.createElement('canvas');
    c3.width = out.width; c3.height = out.height;
    c3.getContext('2d').drawImage(img, 0, 0);
    out = c3;
  }
  const f = out.width / W;
  return { canvas: out, board: { x: bx * f, y: by * f, size: bs * f }, labels, setName, flipped, isGame };
}

function imageDataOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

// Generates n screenshots; returns quantised features (uint8, base64), labels, and detection stats.
export async function batch(n, sets, seedValue, emptyKeep = 0.25, checkDetect = true) {
  seed(seedValue);
  const dim = 2 * FEAT * FEAT;
  const feats = [];
  const labels = [];
  let detected = 0;
  const misses = [];
  for (let i = 0; i < n; i++) {
    const shot = await makeScreenshot(sets);
    const img = imageDataOf(shot.canvas);
    if (checkDetect) {
      const d = detectBoard(img);
      const s = shot.board.size / 8;
      const ok = d && Math.abs(d.x - shot.board.x) < s * 0.15 && Math.abs(d.y - shot.board.y) < s * 0.15 && Math.abs(d.size - shot.board.size) < s * 0.3;
      if (ok) detected++; else misses.push({ i, gt: shot.board, d, set: shot.setName, w: img.width, h: img.height });
    }
    // Train on a slightly jittered board to mimic detection error.
    const s = shot.board.size / 8;
    const jb = { x: shot.board.x + range(-0.04, 0.04) * s, y: shot.board.y + range(-0.04, 0.04) * s, size: shot.board.size * range(0.99, 1.01) };
    const f = squareFeatures(img, jb);
    for (let sq = 0; sq < 64; sq++) {
      if (shot.labels[sq] === 0 && rnd() > emptyKeep) continue;
      const q = new Uint8Array(dim);
      for (let k = 0; k < dim; k++) {
        const v = f[sq * dim + k];
        q[k] = Math.max(0, Math.min(255, Math.round((k < dim / 2 ? v : v + 0.5) * 255)));
      }
      feats.push(q);
      labels.push(shot.labels[sq]);
    }
  }
  const all = new Uint8Array(feats.length * dim);
  feats.forEach((q, i) => all.set(q, i * dim));
  let bin = '';
  for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
  return { feats: btoa(bin), labels, detected, n, misses: misses.slice(0, 10) };
}
