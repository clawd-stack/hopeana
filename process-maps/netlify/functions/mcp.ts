import { getStore } from '../../src/domain/context.ts';
import { EDIT_HELP, GOOD_PRACTICE } from '../../src/domain/agent-guide.ts';
import { MAX_CHANGES, createMapForAgent, editMapForAgent, findMap, listMapsForAgent, readMapForAgent } from '../../src/domain/agent.ts';
import { TEMPLATES } from '../../src/domain/templates.ts';
import { requireAgent } from '../../src/lib/auth.ts';
import { AppError } from '../../src/lib/errors.ts';
import { errorResponse, json } from '../../src/lib/http.ts';
import type { Store, UserRecord } from '../../src/store/types.ts';

/**
 * POST /api/mcp: Process maps as an MCP server, for agents that speak the
 * Model Context Protocol (Claude, and most agent frameworks).
 *
 * Streamable HTTP without sessions or streaming: every request is one JSON-RPC
 * message (or a batch), answered with JSON. That is all a serverless function
 * can do, and all four tools need. The tools are the agent API in
 * src/domain/agent.ts under other names; nothing here touches the store.
 *
 * Key only, like the agent API: "Authorization: Bearer pmk_...", or ?key=.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'process-maps', title: 'WCC Process maps', version: '1.0.0' };

const INSTRUCTIONS = `Process maps is WCC's shared board for mapping processes: steps, decisions, swimlanes, notes and arrows.
Use list_maps to find a map, read_map to see it as an outline, and edit_map to change it. People with the
board open see your edits within a couple of seconds.

${GOOD_PRACTICE}`;

const mapRef = { type: 'string', description: "The map's id, or its name (or a part of the name only one map has)." };

const TOOLS = [
  {
    name: 'list_maps',
    title: 'List process maps',
    description: 'Lists the process maps: id, name, area, status, how many items, who changed it last and a link for people.',
    inputSchema: {
      type: 'object',
      properties: { archived: { type: 'boolean', description: 'List archived maps instead.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_map',
    title: 'Read a process map',
    description:
      'Reads a map as an outline: its lanes top to bottom, and in each lane its steps, decisions, notes and arrows left to right, with who does each step, the system, time, notes and flags. Every item shows its id in [brackets]; use those ids with edit_map.',
    inputSchema: {
      type: 'object',
      properties: {
        map: mapRef,
        format: { type: 'string', enum: ['outline', 'json'], description: 'outline (the default) is easiest to read; json has every field.' },
      },
      required: ['map'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_map',
    title: 'Make a process map',
    description: 'Makes a new map, blank or from a template, and returns its outline.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the process is, e.g. "Supplier invoice to payment".' },
        area: { type: 'string', description: 'Part of the business, e.g. Finance, Workforce, HSEQ.' },
        description: { type: 'string' },
        template: { type: 'string', enum: Object.keys(TEMPLATES), description: 'blank (the default), swimlane, or as-is-to-be.' },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'edit_map',
    title: 'Change a process map',
    description: `Changes a map: add steps, decisions, notes and lanes, update them, connect them, move or delete them. The server lays things out on the board for you.\n\n${EDIT_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        map: mapRef,
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CHANGES,
          description: 'The changes, applied in order, all or nothing.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'update', 'move', 'connect', 'disconnect', 'delete', 'set_map'] },
              kind: { type: 'string', enum: ['step', 'decision', 'start', 'end', 'note', 'text', 'lane'], description: 'add: what to add.' },
              text: { type: 'string', description: 'The words on the shape (add, update).' },
              item: { type: 'string', description: 'update, move, delete: the id or exact text of the item.' },
              id: { type: 'string', description: 'add: an id of your own for the new item.' },
              lane: { type: 'string', description: 'add, update: the lane (name or id) it belongs in.' },
              after: { type: 'string', description: 'add, update: place it just right of this item; on add, also draws an arrow from it.' },
              near: { type: 'string', description: 'add a note or text: place it beside this item.' },
              label: { type: 'string', description: 'Text on an arrow.' },
              connect: { type: 'boolean', description: 'add with after: false to leave out the arrow.' },
              from: { type: 'string', description: 'connect, disconnect: where the arrow starts.' },
              to: { type: 'string', description: 'connect, disconnect: where the arrow ends.' },
              owner: { type: 'string', description: 'Who does the step (a role, e.g. "AP clerk").' },
              system: { type: 'string', description: 'The software it happens in.' },
              duration: { type: 'string', description: 'How long it takes, e.g. "10 min".' },
              notes: { type: 'string' },
              flag: { type: 'string', enum: ['pain', 'idea', 'automated', 'manual', 'question', ''] },
              color: { type: 'string', description: 'yellow, orange, pink, purple, blue, teal, green, grey, white, or #rrggbb.' },
              dashed: { type: 'boolean' },
              x: { type: 'number' },
              y: { type: 'number' },
              name: { type: 'string', description: 'set_map: the map name.' },
              description: { type: 'string', description: 'set_map: the map description.' },
              status: { type: 'string', enum: ['draft', 'in_review', 'agreed'], description: 'set_map.' },
              area: { type: 'string', description: 'set_map.' },
            },
            required: ['action'],
          },
        },
      },
      required: ['map', 'changes'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

type Args = Record<string, unknown>;
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const text = (value: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(structured ? { structuredContent: structured } : {}),
});

async function callTool(store: Store, agent: UserRecord, origin: string, name: string, args: Args): Promise<ToolResult> {
  switch (name) {
    case 'list_maps': {
      const maps = await listMapsForAgent(store, origin, args.archived === true);
      const lines = maps.map(
        (m) => `- "${m.name}" [${m.id}] ${m.status.replace('_', ' ')}${m.area ? `, ${m.area}` : ''}, ${m.items} items, last changed by ${m.updatedBy ?? 'someone'} ${m.updatedAt}`,
      );
      return text(maps.length ? lines.join('\n') : args.archived ? 'No archived maps.' : 'No maps yet. Make one with create_map.', { maps });
    }
    case 'read_map': {
      const map = await findMap(store, args.map);
      const view = await readMapForAgent(store, agent, map.mapId, origin);
      if (args.format === 'json') {
        const { text: outlineText, ...data } = view;
        return text(JSON.stringify(data, null, 2), data as Record<string, unknown>);
      }
      return text(view.text);
    }
    case 'create_map': {
      const view = await createMapForAgent(store, agent, args, origin);
      return text(`Made the map. People can open it at ${view.map.url}\n\n${view.text}`);
    }
    case 'edit_map': {
      const map = await findMap(store, args.map);
      const result = await editMapForAgent(store, agent, map.mapId, { changes: args.changes }, origin);
      const made = result.created.map((c) => `[${c.id}] ${c.kind} "${c.text}"`);
      return text(
        [
          `Applied ${result.applied} change${result.applied === 1 ? '' : 's'} (revision ${result.revision}).`,
          made.length ? `Added: ${made.join(', ')}.` : null,
          result.deleted.length ? `Deleted: ${result.deleted.join(', ')}.` : null,
          ...result.notes,
          '',
          result.outline,
        ]
          .filter((line) => line !== null)
          .join('\n'),
      );
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function answer(store: Store, agent: UserRecord, origin: string, message: RpcMessage) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(-32600, 'Invalid request');
  }
  const params = message.params ?? {};
  try {
    switch (message.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Args) : {};
        try {
          return reply(await callTool(store, agent, origin, name, args));
        } catch (problem) {
          // A refusal is the tool's answer, for the model to read and fix.
          if (problem instanceof AppError) return reply({ ...text(problem.userMessage), isError: true });
          throw problem;
        }
      }
      default:
        return error(-32601, `Method not found: ${message.method}`);
    }
  } catch (problem) {
    if (problem instanceof RpcError) return error(problem.code, problem.message);
    console.error('[process-maps] mcp: unhandled error', problem);
    return error(-32603, 'Something went wrong at our end. Please try again.');
  }
}

export default async (request: Request): Promise<Response> => {
  // No server-to-client stream and no sessions: only POST.
  if (request.method !== 'POST') {
    return new Response('This MCP endpoint takes POST requests. See /llms.txt.', { status: 405, headers: { allow: 'POST' } });
  }
  let store: Store;
  let agent: UserRecord;
  try {
    store = await getStore();
    agent = await requireAgent(request, store);
  } catch (problem) {
    if (problem instanceof AppError && problem.code === 'UNAUTHENTICATED') {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: problem.userMessage } }, 401, {
        'www-authenticate': 'Bearer realm="process-maps"',
      });
    }
    return errorResponse(problem);
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const origin = new URL(request.url).origin;
  const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  const replies = [];
  for (const message of messages) {
    // Notifications (no id) get no reply.
    if (message && typeof message === 'object' && !('id' in message)) continue;
    replies.push(await answer(store, agent, origin, message));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
};

export const config = { path: '/api/mcp' };
