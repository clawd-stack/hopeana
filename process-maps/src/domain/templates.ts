import { DEFAULT_COLOURS, type ConnectorItem, type Item, type NodeItem, type NodeKind, type Side } from './items.ts';

/**
 * Starting points for a new map. Each one is plain items, exactly what the
 * editor would have produced by hand, so a template is nothing more than a
 * head start and can be edited or deleted like anything else.
 */

export const TEMPLATES = {
  blank: 'Blank board',
  swimlane: 'Swimlane process',
  'as-is-to-be': 'As-is and to-be',
} as const;

export type TemplateId = keyof typeof TEMPLATES;

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

function node(id: string, kind: NodeKind, x: number, y: number, w: number, h: number, text: string, extra: Partial<NodeItem> = {}): NodeItem {
  return {
    id,
    kind,
    x,
    y,
    w,
    h,
    z: kind === 'lane' ? -1000 : 1,
    text,
    color: DEFAULT_COLOURS[kind],
    size: 'M',
    owner: '',
    system: '',
    duration: '',
    notes: '',
    flag: '',
    ...extra,
  };
}

function link(id: string, from: string, to: string, text = '', sides: [Side | null, Side | null] = [null, null]): ConnectorItem {
  return {
    id,
    kind: 'connector',
    z: 0,
    from: { id: from, side: sides[0] },
    to: { id: to, side: sides[1] },
    text,
    color: DEFAULT_COLOURS.connector,
    dashed: false,
    arrow: 'end',
    route: 'elbow',
  };
}

const LANE_W = 1640;
const LANE_H = 240;

function swimlane(): Item[] {
  const lane = (i: number, label: string) => node(`lane-${i + 1}`, 'lane', 0, i * LANE_H, LANE_W, LANE_H, label, { z: -1000 + i });
  const mid = (i: number, h: number) => i * LANE_H + (LANE_H - h) / 2;
  return [
    lane(0, 'Requester'),
    lane(1, 'Office'),
    lane(2, 'Systems'),
    node('start', 'terminal', 110, mid(0, 64), 150, 64, 'Start'),
    node('submit', 'step', 340, mid(0, 84), 190, 84, 'Submit request', { owner: 'Requester' }),
    node('check', 'step', 620, mid(1, 84), 190, 84, 'Check details', { owner: 'Office' }),
    node('complete', 'decision', 900, mid(1, 120), 170, 120, 'All details complete?'),
    node('enter', 'step', 1160, mid(2, 84), 190, 84, 'Enter into system', { system: 'Peggy' }),
    node('end', 'terminal', 1430, mid(2, 64), 150, 64, 'End'),
    node('tip', 'sticky', 1180, mid(0, 150), 170, 150, 'Double-click anywhere to add a note. Drag the blue dots on a step to connect it.', {
      color: '#fff1a8',
      size: 'S',
    }),
    link('c1', 'start', 'submit'),
    link('c2', 'submit', 'check'),
    link('c3', 'check', 'complete'),
    link('c4', 'complete', 'enter', 'Yes'),
    link('c5', 'complete', 'submit', 'No', ['top', 'right']),
    link('c6', 'enter', 'end'),
  ];
}

function asIsToBe(): Item[] {
  const H = 300;
  const GAP = 80;
  const lane = (i: number, label: string, color: string) =>
    node(`lane-${i + 1}`, 'lane', 0, i * (H + GAP), LANE_W, H, label, { z: -1000 + i, color });
  const row = (i: number, h: number) => i * (H + GAP) + (H - h) / 2;
  const flow = (i: number, prefix: string, steps: string[]): Item[] => {
    const items: Item[] = [node(`${prefix}-start`, 'terminal', 110, row(i, 64), 150, 64, 'Start')];
    steps.forEach((label, n) => items.push(node(`${prefix}-s${n + 1}`, 'step', 340 + n * 280, row(i, 84), 190, 84, label)));
    items.push(node(`${prefix}-end`, 'terminal', 340 + steps.length * 280, row(i, 64), 150, 64, 'End'));
    const ids = items.map((item) => item.id);
    for (let n = 0; n < ids.length - 1; n++) items.push(link(`${prefix}-c${n + 1}`, ids[n]!, ids[n + 1]!));
    return items;
  };
  return [
    lane(0, 'As-is (today)', '#f6f1ee'),
    lane(1, 'To-be (in Peggy)', '#eef4f9'),
    ...flow(0, 'asis', ['Step today', 'Re-keyed into a spreadsheet', 'Checked by hand']),
    ...flow(1, 'tobe', ['Step in Peggy', 'Checked automatically', 'Reviewed by a person']),
    node('legend', 'sticky', 1480, row(0, 150) - 0, 150, 150, 'Select a step and open Details to record owner, system, time and pain points.', {
      color: '#fde2e4',
      size: 'S',
      z: 2,
    }),
  ];
}

export function templateItems(id: TemplateId): Item[] {
  if (id === 'swimlane') return swimlane();
  if (id === 'as-is-to-be') return asIsToBe();
  return [];
}
