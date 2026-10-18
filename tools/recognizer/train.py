"""Trains the square classifier used by recognizer.js (plain NumPy, CPU).

Input: <name>.u8 (uint8 features, 2*24*24 per sample) + <name>.labels.json from gen.mjs.
Output: vendor/piece-model.bin -- a JSON header line, then per layer int8 weights
(row-major, out x in) and float32 biases.

Usage: python3 train.py OUT.bin TRAIN_PREFIX [TRAIN_PREFIX ...] --test TEST_PREFIX [...]
"""
import json
import sys
import time

import numpy as np

DIM = 2 * 24 * 24
CLASSES = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']
HIDDEN = [256, 128]


def load(prefixes):
    xs, ys = [], []
    for p in prefixes:
        y = np.array(json.load(open(p + '.labels.json')), dtype=np.int64)
        x = np.fromfile(p + '.u8', dtype=np.uint8).reshape(-1, DIM)
        assert len(x) == len(y), p
        xs.append(x)
        ys.append(y)
    x = np.concatenate(xs).astype(np.float32) / 255.0
    x[:, DIM // 2:] -= 0.5  # second channel was stored shifted by +0.5
    return x, np.concatenate(ys)


def init(sizes, rng):
    params = []
    for a, b in zip(sizes[:-1], sizes[1:]):
        params.append([rng.standard_normal((a, b)).astype(np.float32) * np.sqrt(2.0 / a), np.zeros(b, np.float32)])
    return params


def forward(params, x, train=False, rng=None, drop=0.0):
    acts = [x]
    h = x
    for i, (w, b) in enumerate(params):
        h = h @ w + b
        if i < len(params) - 1:
            h = np.maximum(h, 0)
            if train and drop:
                h = h * (rng.random(h.shape) > drop) / (1 - drop)
        acts.append(h)
    return acts


def softmax(z):
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def augment(x, rng):
    # Small shifts (pieces are not always centred) and contrast changes.
    n = len(x)
    img = x.reshape(n, 2, 24, 24)
    out = np.empty_like(img)
    for i in range(n):
        dy, dx = rng.integers(-1, 2, 2)
        out[i] = np.roll(img[i], (dy, dx), axis=(1, 2))
    out[:, 0] *= rng.uniform(0.8, 1.2, (n, 1, 1)).astype(np.float32)
    return np.clip(out, -1, 1).reshape(n, -1)


def evaluate(params, x, y):
    pred = np.concatenate([forward(params, x[i:i + 4096])[-1].argmax(1) for i in range(0, len(x), 4096)])
    acc = (pred == y).mean()
    conf = np.zeros((len(CLASSES), len(CLASSES)), int)
    np.add.at(conf, (y, pred), 1)
    return acc, conf


def train(x, y, epochs, rng, tests):
    params = init([DIM] + HIDDEN + [len(CLASSES)], rng)
    m = [[np.zeros_like(p) for p in layer] for layer in params]
    v = [[np.zeros_like(p) for p in layer] for layer in params]
    counts = np.bincount(y, minlength=len(CLASSES)).astype(np.float32)
    cw = (counts.sum() / (len(CLASSES) * np.maximum(counts, 1))) ** 0.5
    lr, b1, b2, t, bs = 1e-3, 0.9, 0.999, 0, 256
    for ep in range(epochs):
        t0 = time.time()
        order = rng.permutation(len(x))
        if ep == int(epochs * 0.6) or ep == int(epochs * 0.85):
            lr *= 0.3
        loss_sum = 0.0
        for k in range(0, len(x), bs):
            idx = order[k:k + bs]
            xb = augment(x[idx], rng)
            yb = y[idx]
            acts = forward(params, xb, train=True, rng=rng, drop=0.2)
            p = softmax(acts[-1])
            wb = cw[yb]
            loss_sum += float(-(np.log(p[np.arange(len(yb)), yb] + 1e-9) * wb).sum())
            g = p
            g[np.arange(len(yb)), yb] -= 1
            g *= wb[:, None] / len(yb)
            t += 1
            for li in range(len(params) - 1, -1, -1):
                w, b = params[li]
                gw = acts[li].T @ g + 1e-5 * w
                gb = g.sum(0)
                if li > 0:
                    g = (g @ w.T) * (acts[li] > 0)
                for j, gr in enumerate((gw, gb)):
                    m[li][j] = b1 * m[li][j] + (1 - b1) * gr
                    v[li][j] = b2 * v[li][j] + (1 - b2) * gr * gr
                    mh = m[li][j] / (1 - b1 ** t)
                    vh = v[li][j] / (1 - b2 ** t)
                    params[li][j] -= lr * mh / (np.sqrt(vh) + 1e-8)
        msg = f'epoch {ep + 1}/{epochs} loss {loss_sum / len(x):.4f} ({time.time() - t0:.0f}s)'
        for name, (tx, ty) in tests.items():
            msg += f' | {name} acc {evaluate(params, tx, ty)[0]:.4f}'
        print(msg, flush=True)
    return params


def export(params, path):
    layers, blobs = [], []
    for w, b in params:
        wt = w.T  # out x in
        scale = float(np.abs(wt).max() / 127.0)
        q = np.clip(np.round(wt / scale), -127, 127).astype(np.int8)
        layers.append({'in': int(w.shape[0]), 'out': int(w.shape[1]), 'scale': scale})
        blobs += [q.tobytes(), b.astype(np.float32).tobytes()]
    header = json.dumps({'classes': CLASSES, 'feat': 24, 'layers': layers}).encode() + b'\n'
    with open(path, 'wb') as f:
        f.write(header)
        for blob in blobs:
            f.write(blob)


def quantized(params):
    out = []
    for w, b in params:
        scale = np.abs(w).max() / 127.0
        out.append([np.clip(np.round(w / scale), -127, 127) * scale, b])
    return out


if __name__ == '__main__':
    args = sys.argv[1:]
    out = args[0]
    split = args.index('--test') if '--test' in args else len(args)
    train_p, test_p = args[1:split], args[split + 1:]
    epochs = int(dict(a.split('=') for a in args if a.startswith('epochs=')).get('epochs', 12)) if any(a.startswith('epochs=') for a in args) else 12
    train_p = [p for p in train_p if not p.startswith('epochs=')]
    test_p = [p for p in test_p if not p.startswith('epochs=')]
    rng = np.random.default_rng(0)
    x, y = load(train_p)
    print('train', x.shape, np.bincount(y, minlength=13).tolist(), flush=True)
    tests = {p.split('/')[-1]: load([p]) for p in test_p}
    params = train(x, y, epochs, rng, tests)
    q = quantized(params)
    for name, (tx, ty) in tests.items():
        acc, conf = evaluate(q, tx, ty)
        print(f'[int8] {name} acc {acc:.4f}')
        print('confusion (rows=true):', ' '.join(f'{c:>4}' for c in CLASSES))
        for i, row in enumerate(conf):
            print(f'  {CLASSES[i]:>3}', ' '.join(f'{v:>4}' for v in row))
    export(params, out)
    print('wrote', out)
