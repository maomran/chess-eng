// Reads a chess position from a screenshot using Claude's vision.
// The SDK bundle is loaded lazily so the rest of the app works offline.

const MODEL = 'claude-opus-5-5';
const MAX_SIDE = 1568;

const SCHEMA = {
  type: 'object',
  properties: {
    found_board: { type: 'boolean', description: 'False if there is no chess board in the image.' },
    bottom_side: { type: 'string', enum: ['white', 'black'], description: 'Which side\'s pieces start at the bottom edge of the board as shown in the image.' },
    ranks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactly 8 strings, rank 8 first down to rank 1 (standard orientation, White at the bottom, regardless of how the image is drawn). Each string has exactly 8 characters for files a..h: K Q R B N P for white pieces, k q r b n p for black pieces, . for an empty square.',
    },
    side_to_move: { type: 'string', enum: ['white', 'black', 'unknown'], description: 'Whose turn it is, if the image shows it (highlighted last move, clock, "to move" text). Otherwise unknown.' },
    notes: { type: 'string', description: 'Short note about anything uncertain, empty if none.' },
  },
  required: ['found_board', 'bottom_side', 'ranks', 'side_to_move', 'notes'],
  additionalProperties: false,
};

const PROMPT = `This image contains a chess board (a screenshot from a chess app or website, a diagram, or a photo).
Read the position square by square.

- Use the rank/file labels on the board if they are visible to work out the orientation. Without labels, a board with the black pieces mostly at the bottom is usually drawn from Black's side.
- Report the position in standard orientation (rank 8 first, file a on the left, as seen from White), even if the image shows it flipped.
- Count carefully: each rank string must be exactly 8 characters.
- If the last move is highlighted, the side that did NOT make that move is to move.`;

// Shrinks the image and returns { mediaType, data } with base64 JPEG data.
async function encodeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

// Returns { placement: 8 rank strings rank8..rank1, bottomSide, sideToMove, notes }.
export async function readBoardFromImage(file, apiKey, hints = {}) {
  const { default: Anthropic } = await import('./vendor/anthropic-sdk.js');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const image = await encodeImage(file);

  let text = PROMPT;
  if (hints.bottomSide) text += `\n\nThe user says ${hints.bottomSide} is at the bottom of the board in this image.`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  if (response.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again.');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('No answer came back. Try again.');
  const result = JSON.parse(block.text);
  if (!result.found_board) throw new Error('No chess board was found in this image.');

  return {
    placement: normalizeRanks(result.ranks),
    bottomSide: result.bottom_side,
    sideToMove: result.side_to_move,
    notes: result.notes,
  };
}

// Forces the answer into 8 ranks of 8 valid characters.
function normalizeRanks(ranks) {
  const out = [];
  for (let r = 0; r < 8; r++) {
    const raw = String(ranks[r] ?? '').replace(/\s/g, '');
    let row = '';
    for (const ch of raw) {
      if (/^[1-8]$/.test(ch)) row += '.'.repeat(+ch);
      else row += /^[KQRBNPkqrbnp]$/.test(ch) ? ch : '.';
    }
    out.push(row.padEnd(8, '.').slice(0, 8));
  }
  return out;
}
