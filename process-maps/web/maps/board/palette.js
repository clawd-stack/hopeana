/**
 * Colours, sizes and flags. One place, so the board, the details panel and
 * the PNG export can never disagree about what a colour or a flag means.
 */

export const COLOURS = {
  sticky: ['#fff1a8', '#ffd8a8', '#fde2e4', '#e5dbff', '#d0ebff', '#c3fae8', '#d3f9d8', '#e9ecef'],
  shape: ['#ffffff', '#e7f1fb', '#e3f1e4', '#fff4e0', '#fde8e8', '#efe9fb', '#e3f6f4', '#f1f3f5'],
  lane: ['#f3f5f8', '#eef4f9', '#f6f1ee', '#eef6ef', '#fbf3e6', '#f4eff9', '#fdf0f0', '#ffffff'],
  text: ['#1f2328', '#59606a', '#2a78d6', '#c92a2a', '#2b8a3e', '#e8590c', '#7048e8', '#0c8599'],
  connector: ['#4b5563', '#2a78d6', '#c92a2a', '#2b8a3e', '#e8590c', '#7048e8', '#0c8599', '#adb5bd'],
};

export function colourGroup(kind) {
  if (kind === 'sticky' || kind === 'lane' || kind === 'text' || kind === 'connector') return kind;
  return 'shape';
}

export const DEFAULT_COLOUR = {
  sticky: COLOURS.sticky[0],
  step: '#ffffff',
  decision: '#fff4e0',
  terminal: '#e3f1e4',
  text: COLOURS.text[0],
  lane: COLOURS.lane[0],
  connector: COLOURS.connector[0],
};

export const DEFAULT_SIZE = {
  sticky: [180, 180],
  step: [190, 84],
  decision: [170, 120],
  terminal: [150, 64],
  text: [240, 34],
  lane: [1400, 240],
};

export const KIND_LABELS = {
  sticky: 'Sticky note',
  step: 'Process step',
  decision: 'Decision',
  terminal: 'Start / end',
  text: 'Text',
  lane: 'Swimlane',
  connector: 'Connector',
};

/** Font size in board units for each text size, per kind. */
const FONT = {
  sticky: { S: 15, M: 20, L: 28, XL: 40 },
  text: { S: 14, M: 18, L: 28, XL: 44 },
  shape: { S: 13, M: 15.5, L: 20, XL: 28 },
};
export function fontSize(kind, size) {
  const table = kind === 'sticky' ? FONT.sticky : kind === 'text' ? FONT.text : FONT.shape;
  return table[size] ?? table.M;
}

export const FLAGS = {
  pain: { label: 'Pain point', colour: '#d6336c', glyph: '!' },
  idea: { label: 'Improvement idea', colour: '#f08c00', glyph: '+' },
  automated: { label: 'Automated', colour: '#2b8a3e', glyph: '✓' },
  manual: { label: 'Manual', colour: '#868e96', glyph: 'M' },
  question: { label: 'Open question', colour: '#1c7ed6', glyph: '?' },
};

function parse(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Mixes a colour towards another; amount 0 is a, 1 is b. */
export function mix(a, b, amount) {
  const ca = parse(a);
  const cb = parse(b);
  return hex(ca.map((v, i) => v + (cb[i] - v) * amount));
}

/** The outline drawn round a filled shape: the fill, darkened towards slate. */
export function borderFor(fill) {
  return mix(fill, '#2f3a48', 0.42);
}

/** A lane's header band: a touch deeper than its body. */
export function laneHeadFor(fill) {
  return mix(fill, '#2f3a48', 0.07);
}
