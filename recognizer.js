// On-device chess position recognition from a screenshot. No network needed.
//
// 1. detectBoard finds the 8x8 grid: grid lines show up as evenly spaced peaks in the
//    image's edge profiles, and the winning candidate must look like a checkerboard.
// 2. squareFeatures turns each square into a small 2-channel image: how far each pixel is
//    from the square's own background colour, and the brightness of those foreground pixels.
// 3. A small neural network (trained on synthetic boards, see tools/recognizer) labels each square.
// 4. readPosition applies chess sense: one king each, no pawns on the back ranks, and works
//    out which side is at the bottom.

export const FEAT = 24;
export const CLASSES = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

const DETECT_SIDE = 640;

// ---------- image helpers ----------

export async function fileToImageData(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return ctx.getImageData(0, 0, w, h);
}

function luminance(img) {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

function downscale(img, scale) {
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * img.width + xx) * 4;
          r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++;
        }
      }
      const q = (y * w + x) * 4;
      out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

function pixel(img, x, y) {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const p = (yi * img.width + xi) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1];
}

// Background colour of a square: median of small patches in its four corners
// (pieces sit in the middle; coordinate labels touch at most one or two corners).
function squareBackground(img, x0, y0, s) {
  const inset = s * 0.05;
  const patch = Math.max(1, s * 0.1);
  const rs = [], gs = [], bs = [];
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const px = cx ? x0 + s - inset - patch : x0 + inset;
    const py = cy ? y0 + s - inset - patch : y0 + inset;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const [r, g, b] = pixel(img, px + (patch * i) / 2, py + (patch * j) / 2);
        rs.push(r); gs.push(g); bs.push(b);
      }
    }
  }
  return [median(rs), median(gs), median(bs)];
}

function colorDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------- board detection ----------

// Edge profiles: summed |horizontal gradient| per column and |vertical gradient| per row,
// limited to a band of the image.
function profiles(gray, w, h, band) {
  const { x0 = 0, x1 = w, y0 = 0, y1 = h } = band || {};
  const px = new Float32Array(w);
  const py = new Float32Array(h);
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const row = y * w;
    for (let x = Math.max(0, x0); x < Math.min(w, x1) - 1; x++) px[x] += Math.abs(gray[row + x + 1] - gray[row + x]);
  }
  for (let y = Math.max(0, y0); y < Math.min(h, y1) - 1; y++) {
    const row = y * w;
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) py[y] += Math.abs(gray[row + w + x] - gray[row + x]);
  }
  return { px, py };
}

function peakAt(p, x) {
  const i = Math.round(x);
  let m = 0;
  for (let d = -1; d <= 1; d++) if (i + d >= 0 && i + d < p.length) m = Math.max(m, p[i + d]);
  return m;
}

function valueAt(p, x) {
  const i = Math.round(x);
  return i >= 0 && i < p.length ? p[i] : 0;
}

// Best (start, step) for 7 evenly spaced interior grid lines in profile p.
function gridCandidates(p, minS, maxS, keep, stepInc = 1) {
  const found = [];
  for (let s = minS; s <= maxS; s += stepInc) {
    for (let x0 = 0; x0 + 8 * s < p.length; x0++) {
      let on = 0, off = 0;
      for (let i = 1; i <= 7; i++) {
        on += peakAt(p, x0 + i * s);
        off += valueAt(p, x0 + (i - 0.5) * s) + valueAt(p, x0 + (i + 0.5) * s);
      }
      found.push({ start: x0, step: s, score: on - off / 2 });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of found) {
    if (out.length >= keep) break;
    if (out.some((o) => Math.abs(o.start - c.start) < o.step / 2 && Math.abs(o.step - c.step) < o.step * 0.08)) continue;
    out.push(c);
  }
  return out;
}

// How much the board at (x, y, s) looks like a checkerboard: two distinct colours, and
// (almost) every square closer to its own colour than to the other one.
function checkerScore(img, x, y, s) {
  const groups = [[], []];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) groups[(r + c) % 2].push(squareBackground(img, x + c * s, y + r * s, s));
  }
  const med = groups.map((g) => [0, 1, 2].map((k) => median(g.map((v) => v[k]))));
  const sep = colorDist(med[0], med[1]);
  if (sep < 12) return 0;
  let matches = 0;
  let spread = 0;
  groups.forEach((g, i) => {
    for (const v of g) {
      const own = colorDist(v, med[i]);
      if (own < colorDist(v, med[1 - i]) && own < sep * 0.45) matches++;
      spread += Math.min(own, sep);
    }
  });
  return (sep / (8 + spread / 64)) * (matches / 64) ** 6;
}

export function detectBoard(img) {
  const scale = Math.min(1, DETECT_SIDE / Math.max(img.width, img.height));
  const small = downscale(img, scale);
  const w = small.width;
  const h = small.height;
  const gray = luminance(small);
  const { px, py } = profiles(gray, w, h);
  const minDim = Math.min(w, h);
  const minS = Math.max(6, Math.floor((minDim * 0.2) / 8));
  const maxS = Math.floor(minDim / 8);
  const xs = gridCandidates(px, minS, maxS, 8);
  const ys = gridCandidates(py, minS, maxS, 8);

  // Text and buttons elsewhere in the screenshot can drown out the board in one direction,
  // so for every candidate in one direction, search the other one only within that band.
  const combos = [];
  for (const cy of ys) {
    const band = profiles(gray, w, h, { y0: Math.round(cy.start), y1: Math.round(cy.start + 8 * cy.step) }).px;
    for (const cx of gridCandidates(band, Math.floor(cy.step * 0.94), Math.ceil(cy.step * 1.06), 3, 0.5)) combos.push([cx, cy]);
  }
  for (const cx of xs) {
    const band = profiles(gray, w, h, { x0: Math.round(cx.start), x1: Math.round(cx.start + 8 * cx.step) }).py;
    for (const cy of gridCandidates(band, Math.floor(cx.step * 0.94), Math.ceil(cx.step * 1.06), 3, 0.5)) combos.push([cx, cy]);
  }

  let best = null;
  for (const [cx, cy] of combos) {
    if (Math.abs(cx.step - cy.step) > Math.max(1.5, cx.step * 0.06)) continue;
    const s = (cx.step + cy.step) / 2;
    if (cx.start + 8 * s > w + 1 || cy.start + 8 * s > h + 1) continue;
    const score = checkerScore(small, cx.start, cy.start, s);
    if (!best || score > best.score) best = { x: cx.start, y: cy.start, s, score };
  }
  if (!best) return null;
  // The board's outer border also looks like a grid line, so try shifting by a square.
  const centre = best;
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      const x = centre.x + dx * centre.s;
      const y = centre.y + dy * centre.s;
      if ((!dx && !dy) || x < -1 || y < -1 || x + 8 * centre.s > w + 1 || y + 8 * centre.s > h + 1) continue;
      const score = checkerScore(small, x, y, centre.s);
      if (score > best.score) best = { x, y, s: centre.s, score };
    }
  }
  if (best.score < 0.5) return null;

  // Refine at full resolution using edge profiles limited to the board area.
  const full = { x: best.x / scale, y: best.y / scale, s: best.s / scale };
  const grayFull = luminance(img);
  const pad = full.s * 0.5;
  const band = {
    x0: Math.floor(full.x - pad), x1: Math.ceil(full.x + 8 * full.s + pad),
    y0: Math.floor(full.y - pad), y1: Math.ceil(full.y + 8 * full.s + pad),
  };
  const fp = profiles(grayFull, img.width, img.height, {
    x0: band.x0, x1: band.x1, y0: Math.floor(full.y + full.s), y1: Math.ceil(full.y + 7 * full.s),
  });
  const fq = profiles(grayFull, img.width, img.height, {
    x0: Math.floor(full.x + full.s), x1: Math.ceil(full.x + 7 * full.s), y0: band.y0, y1: band.y1,
  });
  const refine = (p, start, step) => {
    let bestR = { start, step, score: -Infinity };
    const r = Math.max(2, 1 / scale + 1);
    for (let s = step - r / 4; s <= step + r / 4; s += 0.25) {
      for (let x0 = start - r; x0 <= start + r; x0 += 0.5) {
        let on = 0;
        for (let i = 1; i <= 7; i++) on += valueAt(p, x0 + i * s);
        if (on > bestR.score) bestR = { start: x0, step: s, score: on };
      }
    }
    return bestR;
  };
  const rx = refine(fp.px, full.x, full.s);
  const ry = refine(fq.py, full.y, full.s);
  const size = 8 * (rx.step + ry.step) / 2;
  return { x: rx.start, y: ry.start, size, score: best.score };
}

// ---------- features ----------

// Returns Float32Array(64 * 2 * FEAT * FEAT), squares in image order (row 0 = top).
export function squareFeatures(img, board) {
  const s = board.size / 8;
  const n = FEAT * FEAT;
  const out = new Float32Array(64 * 2 * n);
  const sub = 3;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const x0 = board.x + c * s;
      const y0 = board.y + r * s;
      const bg = squareBackground(img, x0, y0, s);
      const base = (r * 8 + c) * 2 * n;
      for (let i = 0; i < FEAT; i++) {
        for (let j = 0; j < FEAT; j++) {
          let fg = 0, lum = 0;
          for (let a = 0; a < sub; a++) {
            for (let b = 0; b < sub; b++) {
              const px = pixel(img, x0 + ((j + (b + 0.5) / sub) * s) / FEAT, y0 + ((i + (a + 0.5) / sub) * s) / FEAT);
              fg += colorDist(px, bg);
              lum += 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
            }
          }
          fg = Math.min(1, fg / (sub * sub) / 200);
          lum = lum / (sub * sub) / 255;
          out[base + i * FEAT + j] = fg;
          out[base + n + i * FEAT + j] = (lum - 0.5) * Math.min(1, fg * 4);
        }
      }
    }
  }
  return out;
}

// ---------- classifier ----------

let modelPromise = null;

// Model file: JSON header line, then int8 weights. Layers are dense, ReLU between them.
export function loadModel(url = new URL('./vendor/piece-model.bin', import.meta.url)) {
  if (!modelPromise) {
    modelPromise = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error('Could not load the piece recognizer.');
      return parseModel(await res.arrayBuffer());
    });
  }
  return modelPromise;
}

export function parseModel(buf) {
  const bytes = new Uint8Array(buf);
  const nl = bytes.indexOf(10);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
  let off = nl + 1;
  const layers = meta.layers.map((l) => {
    const W = new Int8Array(buf, off, l.in * l.out);
    off += l.in * l.out;
    const B = new Float32Array(buf.slice(off, off + 4 * l.out));
    off += 4 * l.out;
    return { ...l, W, B };
  });
  return { ...meta, layers };
}

export function classify(model, features) {
  const dim = model.layers[0].in;
  const probs = [];
  for (let sq = 0; sq < features.length / dim; sq++) {
    let x = features.subarray(sq * dim, (sq + 1) * dim);
    model.layers.forEach((l, li) => {
      const y = new Float32Array(l.out);
      for (let o = 0; o < l.out; o++) {
        let acc = 0;
        const row = o * l.in;
        for (let k = 0; k < l.in; k++) acc += l.W[row + k] * x[k];
        y[o] = acc * l.scale + l.B[o];
        if (li < model.layers.length - 1 && y[o] < 0) y[o] = 0;
      }
      x = y;
    });
    const m = Math.max(...x);
    const e = x.map((v) => Math.exp(v - m));
    const sum = e.reduce((a, b) => a + b, 0);
    probs.push(Array.from(e, (v) => v / sum));
  }
  return probs;
}

// ---------- position ----------

// Which side is at the bottom of the image. Pawns only move forward, so White's pawns are
// almost always "below" Black's when White is at the bottom; kings and the other pieces
// break ties.
function guessBottom(labels) {
  const avgRow = (set) => {
    let sum = 0, n = 0;
    labels.forEach((l, i) => { if (set.includes(l)) { sum += i >> 3; n++; } });
    return n ? sum / n : null;
  };
  const votes = [
    [avgRow(['P']), avgRow(['p']), 3],
    [avgRow(['K']), avgRow(['k']), 1],
    [avgRow(['N', 'B', 'R', 'Q']), avgRow(['n', 'b', 'r', 'q']), 0.5],
  ];
  let score = 0;
  for (const [w, b, weight] of votes) if (w !== null && b !== null) score += Math.sign(w - b) * weight;
  return score < 0 ? 'black' : 'white';
}

// probs: 64 arrays (image order). Returns ranks in standard orientation (rank 8 first),
// which side is at the bottom, and the squares the model was unsure about.
export function readPosition(probs, bottomHint = null) {
  const labels = probs.map((p) => CLASSES[p.indexOf(Math.max(...p))]);

  let bottom = bottomHint || guessBottom(labels);

  // Map image square index -> standard square index (0 = a8 ... 63 = h1).
  const toStd = (i) => (bottom === 'white' ? i : 63 - i);
  const std = new Array(64);
  const stdProbs = new Array(64);
  labels.forEach((l, i) => { std[toStd(i)] = l; stdProbs[toStd(i)] = probs[i]; });

  const pick = (sq, banned) => {
    const p = stdProbs[sq];
    let bestK = 0;
    for (let k = 0; k < CLASSES.length; k++) if (!banned.includes(CLASSES[k]) && p[k] > p[bestK]) bestK = k;
    if (banned.includes(CLASSES[bestK])) bestK = 0;
    return CLASSES[bestK];
  };

  // Exactly one king per side: keep the most likely one, relabel the others.
  for (const k of ['K', 'k']) {
    const ki = CLASSES.indexOf(k);
    let bestSq = -1;
    for (let sq = 0; sq < 64; sq++) if (bestSq < 0 || stdProbs[sq][ki] > stdProbs[bestSq][ki]) bestSq = sq;
    for (let sq = 0; sq < 64; sq++) if (std[sq] === k && sq !== bestSq) std[sq] = pick(sq, [k]);
    if (stdProbs[bestSq][ki] > 0.02 || !std.includes(k)) std[bestSq] = k;
  }
  // Pawns can't be on the first or last rank.
  for (let sq = 0; sq < 64; sq++) {
    if ((sq < 8 || sq >= 56) && (std[sq] === 'P' || std[sq] === 'p')) std[sq] = pick(sq, ['P', 'p', 'K', 'k']);
  }

  const unsure = [];
  for (let sq = 0; sq < 64; sq++) {
    if (Math.max(...stdProbs[sq]) < 0.6) unsure.push('abcdefgh'[sq % 8] + (8 - (sq >> 3)));
  }
  const ranks = [];
  for (let r = 0; r < 8; r++) ranks.push(std.slice(r * 8, r * 8 + 8).join(''));
  return { ranks, bottom, unsure };
}

export async function recognize(file, { bottomHint = null } = {}) {
  const [img, model] = await Promise.all([fileToImageData(file), loadModel()]);
  const board = detectBoard(img);
  if (!board) throw new Error('No chess board found in this image. Try cropping closer to the board.');
  const probs = classify(model, squareFeatures(img, board));
  return { ...readPosition(probs, bottomHint), board };
}

// For the training/debug tools.
export const _internals = { luminance, downscale, profiles, gridCandidates, checkerScore };
