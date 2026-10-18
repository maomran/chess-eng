// Thin UCI wrapper around the single-threaded Stockfish WASM build.
// Only one search runs at a time; a new request stops the current one and
// starts as soon as the engine reports its bestmove.

const ENGINE_URL = new URL('./vendor/stockfish/stockfish-19-lite-single.js', import.meta.url);

export class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.ready = false;
    this.searching = false;
    this.pending = null;
    this.current = null;
    this.onReady = () => {};
    this.worker.onmessage = (e) => this.#handle(String(e.data));
    this.worker.onerror = (e) => console.error('Engine error', e);
    this.#send('uci');
  }

  #send(cmd) {
    this.worker.postMessage(cmd);
  }

  #handle(line) {
    if (line === 'uciok') {
      this.#send('setoption name Hash value 32');
      this.#send('isready');
      return;
    }
    if (line === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        this.onReady();
      }
      this.#startPending();
      return;
    }
    if (!this.current) return;
    if (line.startsWith('info ') && line.includes(' pv ')) {
      const info = parseInfo(line);
      if (info) this.current.onInfo(info);
    } else if (line.startsWith('bestmove')) {
      const search = this.current;
      this.current = null;
      this.searching = false;
      search.onDone(line.split(' ')[1]);
      this.#startPending();
    }
  }

  #startPending() {
    if (!this.ready || this.searching || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.current = job;
    this.searching = true;
    this.#send(`setoption name Skill Level value ${job.skill ?? 20}`);
    this.#send(`setoption name MultiPV value ${job.multiPv ?? 1}`);
    this.#send(`position fen ${job.fen}`);
    if (job.depth) this.#send(`go depth ${job.depth}`);
    else this.#send(job.movetime > 0 ? `go movetime ${job.movetime}` : 'go infinite');
  }

  // job: { fen, multiPv, skill (0-20), depth or movetime (ms, 0 = infinite), onInfo(info), onDone(bestUci) }
  analyze(job) {
    this.pending = job;
    if (this.searching) {
      // Results from the old search are dropped; its bestmove will start the new one.
      this.current = { onInfo() {}, onDone() {} };
      this.#send('stop');
    } else {
      this.#startPending();
    }
  }

  stop() {
    this.pending = null;
    if (this.searching) this.#send('stop');
  }
}

function parseInfo(line) {
  const t = line.split(' ');
  const info = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'nodes': info.nodes = +t[++i]; break;
      case 'nps': info.nps = +t[++i]; break;
      case 'score': {
        const kind = t[++i];
        const val = +t[++i];
        if (kind === 'cp') info.cp = val;
        else if (kind === 'mate') info.mate = val;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') { info.bound = true; i++; }
        break;
      }
      case 'pv':
        info.pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  if (!info.pv || info.bound) return null;
  return info;
}
