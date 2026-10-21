# Best Move – chess analyzer for iPhone

A web app (installable on the iPhone home screen) that shows the best move for any chess position.
The engine is **Stockfish 19** compiled to WebAssembly, and it runs entirely on your phone.

## Three ways to get a position on the board

1. **Start of the game.** Open the app and tap **Analyze**, or play moves by tapping a piece and then its target square.
2. **Set it up by hand.** In the **Set up** tab, pick a piece and tap squares to place it (the ⌫ button erases).
   Set whose move it is and the castling rights, or paste a FEN, then tap **Done**.
3. **From a screenshot.** In the **Screenshot** tab, choose an image from Photos. The board is read on your phone,
   with no account, no API key and nothing uploaded. The app works out which side is at the bottom and opens the position in
   **Set up** next to your screenshot, with any hard-to-read squares outlined in yellow, so you can check it before analyzing.
   If the board came out upside down, tap **Rotate 180°**. It works best on clean screenshots from chess apps and websites;
   photos of a real board won't work.

Everything runs on your phone and keeps working offline after the first visit.

The analysis shows the best move in large type with a green arrow on the board, for whichever side is to move,
and the second-best move with a black arrow (turn this off with the **2nd best** checkbox).
If the turn is wrong (for example after reading a screenshot), tap **Switch turn**.
Below it are the engine's lines with evaluations from White's side (`+1.20` means White is better, `#-3` means Black mates in 3);
set **Lines** to 3 or 5 to compare alternatives. **Play best move** makes the engine's move on the board.

## Play against the computer

The **Play** tab has 8 levels, from **1 · Beginner** (plays loose moves, good for learning) to **8 · Maximum** (full-strength Stockfish).
Pick your color (or Random) and tap **New game**, or **From this position** to play out a position you set up or loaded from a screenshot.
Tick **Coach** to see the best move (green arrow) and second-best move (black arrow) on each of your turns.
While playing, the evaluation is hidden; **💡 Hint** shows the best move, **↶ Undo** takes back your last move, and **Resign** ends the game.
You can switch to **Analyze** at any time to look at the game with the engine.

## Install on iPhone

1. Host the site (see below) and open the URL in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. It opens full screen like a normal app.

## Hosting

It's a static site with no build step: serve the repo root from any static host.

- **GitHub Pages:** in the repo's *Settings → Pages*, deploy from the `main` branch, root folder.
  Every push to `main` republishes the site.
- **Local:** `python3 -m http.server 8000` and open `http://localhost:8000`
  (to try it on your phone, use your computer's LAN IP on the same Wi-Fi).

The engine is the *lite, single-threaded* Stockfish build (~1.8 MB), which needs no special server headers.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | Page layout and styling |
| `app.js` | Board, move input, setup editor, analysis display |
| `engine.js` | Small UCI wrapper around the Stockfish web worker (also used for the computer opponent's levels) |
| `recognizer.js` | Screenshot → position, on device: finds the board, then a small neural network labels each square |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `vendor/` | Stockfish 19, chess.js 1.4, the recognizer's model weights, piece images |
| `tools/` | Icon script, and `tools/recognizer/` for regenerating training data and retraining the model |

## Licenses

Stockfish is GPL-3.0 (`vendor/stockfish/Copying.txt`), so this app is distributed under GPL-3.0 too.
chess.js is BSD-2-Clause. Piece images are by Cburnett, CC BY-SA 3.0, via cm-chessboard.
