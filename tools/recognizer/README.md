# Screenshot recognizer: training

`recognizer.js` (in the app) finds the board in a screenshot and labels each square with a
small neural network stored in `vendor/piece-model.bin` (~330 KB). The network is trained only on
synthetic screenshots drawn by `synth.js`, using the same feature code the app runs.

## Retraining

1. **Piece sets.** Put piece images in a folder `pieces/<set>/{wK,wQ,…,bP}.{svg,png}`.
   The current model used sets taken from npm packages:
   cburnett (`chessgroundx` CSS data URIs), wikipedia/alpha/uscf (`chessboard-element`),
   chessiro (`chessiro-canvas`), react-chess-pieces, and cm-chessboard's standard/staunty sprites
   (split into one SVG per piece). Font sets (`font:DejaVu Sans`, `font:FreeSerif`, `font:FreeMono`)
   are drawn from the Unicode chess symbols, so they only need the font installed.
2. **Serve.** Make a folder with a symlink `app` → this repo and `pieces` → your piece folder,
   and serve it: `python3 -m http.server 8766`.
3. **Generate.** `npm i playwright`, then for example
   `node gen.mjs data/tr_0 700 50 9000000 "cburnett,alpha,uscf,font:DejaVu Sans" 0`
   (run several in parallel with different seeds, plus one test set with `CHECK_DETECT=1` to
   measure board detection).
4. **Train.** `python3 train.py ../../vendor/piece-model.bin data/tr_0 data/tr_1 … --test data/te_all epochs=15`
   (NumPy only, about 2 minutes on a laptop CPU).

Results for the shipped model: board found in 99.7% of 300 synthetic test screenshots,
99.7% of squares right, and 99.8% of squares right on a piece set left out of training.
