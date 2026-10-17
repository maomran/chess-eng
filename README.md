# Best Move – chess analyzer for iPhone

A web app (installable on the iPhone home screen) that shows the best move for any chess position.
The engine is **Stockfish 19** compiled to WebAssembly, and it runs entirely on your phone.

## Three ways to get a position on the board

1. **Start of the game.** Open the app and tap **Analyze**, or play moves by tapping a piece and then its target square.
2. **Set it up by hand.** In the **Set up** tab, pick a piece and tap squares to place it (the ⌫ button erases).
   Set whose move it is and the castling rights, or paste a FEN, then tap **Done**.
3. **From a screenshot.** In the **Screenshot** tab, choose an image from Photos. Claude reads the position,
   works out which way the board is drawn, and opens it in **Set up** next to your screenshot so you can check it before analyzing.
   This step needs an Anthropic API key (from console.anthropic.com). The key is saved only on your device
   and sent only to `api.anthropic.com`. Everything else works without a key, and offline after the first visit.

The analysis shows the top 1–5 lines with evaluations from White's side (`+1.20` means White is better, `#3` means mate in 3),
arrows for the best two moves, and an evaluation bar. **Play best move** makes the engine's move on the board.

## Install on iPhone

1. Host the site (see below) and open the URL in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. It opens full screen like a normal app.

## Hosting

It's a static site with no build step: serve the repo root from any static host.

- **GitHub Pages:** in the repo's *Settings → Pages*, set *Source* to **GitHub Actions**.
  The workflow in `.github/workflows/pages.yml` publishes every push to `main`.
- **Local:** `python3 -m http.server 8000` and open `http://localhost:8000`
  (to try it on your phone, use your computer's LAN IP on the same Wi-Fi).

The engine is the *lite, single-threaded* Stockfish build (~1.8 MB), which needs no special server headers.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | Page layout and styling |
| `app.js` | Board, move input, setup editor, analysis display |
| `engine.js` | Small UCI wrapper around the Stockfish web worker |
| `vision.js` | Screenshot → position using the Claude API (`claude-opus-5-5`, structured JSON output) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Stockfish 19, chess.js 1.4, the Anthropic JS SDK (bundled with esbuild), piece images |
| `tools/` | Scripts used to make the icons and the SDK bundle |

## Licenses

Stockfish is GPL-3.0 (`vendor/stockfish/Copying.txt`), so this app is distributed under GPL-3.0 too.
chess.js is BSD-2-Clause. Piece images are by Cburnett, CC BY-SA 3.0, via cm-chessboard.
