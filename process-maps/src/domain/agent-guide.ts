/**
 * The guide an agent reads first, at /llms.txt and /api/agent. Plain words
 * and copyable examples: it is the whole manual, since an agent cannot see
 * the board or ask somebody where a button is.
 */

export const EDIT_HELP = `Changes are a list; all of them land together, or none do (the error says which change failed and why).
Refer to anything by its id (shown in [brackets] when you read a map) or by its exact text.

- add a shape:
  {"action":"add","kind":"step","text":"Check the invoice","lane":"AP clerk","after":"Invoice arrives"}
  kind: step, decision, start, end, note, text or lane.
  lane: puts it in that swimlane. If no lane has that name yet, a new lane is made at the bottom.
  after: puts it just right of that item and draws an arrow from it. "label" puts text on the arrow
  (e.g. "Yes" after a decision); "connect": false leaves the arrow out.
  Without lane or after, a shape goes to the right of the last one you added.
  Notes and text go beside the item named in "after" or "near".
  Optional: "owner" (who does it), "system", "duration", "notes", "flag", "color",
  and "id" (your own id, so later changes in the same request can refer to it).
- add a lane: {"action":"add","kind":"lane","text":"Finance manager"}
- update: {"action":"update","item":"Check the invoice","text":"New wording","owner":"AP clerk","system":"Xero","duration":"5 min","notes":"...","flag":"pain"}
  flag: pain, idea, automated, manual, question, or "" to clear it.
  color: yellow, orange, pink, purple, blue, teal, green, grey, white, or #rrggbb.
  To move it, add "lane" (into that lane), "after" (just right of that item), or "x" and "y".
  To label an arrow: {"action":"update","item":"<connector id>","label":"Yes"}
- connect: {"action":"connect","from":"Approved?","to":"Pay the supplier","label":"Yes"}
- disconnect: {"action":"disconnect","from":"Approved?","to":"Pay the supplier"}
- delete: {"action":"delete","item":"Check the invoice"} (a shape's arrows go with it; deleting a lane leaves what was in it)
- set_map: {"action":"set_map","name":"...","description":"...","status":"in_review","area":"Finance"}
  status: draft, in_review or agreed.`;

export const GOOD_PRACTICE = `- Read the map before you change it, and use the ids it shows.
- Build a flow in order: add each step "after" the one before it, in its lane.
- Put questions and doubts in notes (kind "note", flag "question") rather than rewriting someone's steps.
- People see your edits within a couple of seconds, outlined with your name, and can undo them.`;

export function agentGuide(origin: string): string {
  return `# Process maps: guide for agents

Process maps is WCC's shared board for mapping how work gets done: process steps, decisions,
swimlanes, sticky notes and the arrows between them. People edit it in a browser at
${origin}/maps/

The board is drawn by JavaScript, so a fetched page looks empty. That is expected: agents read
and edit maps through the API below instead. Your changes appear on the board for everyone who
has it open, within a couple of seconds.

## 1. Get an access key

An admin adds you on the Team page (${origin}/maps/team.html, "Add agent") and gives you a key
that starts with pmk_. Send it with every request:

    Authorization: Bearer pmk_...

If you cannot set headers, add ?key=pmk_... to the URL instead. Prefer the header: URLs get logged.

## 2. Connect over MCP (easiest for Claude and other MCP clients)

    URL:     ${origin}/api/mcp
    Header:  Authorization: Bearer pmk_...
    Tools:   list_maps, read_map, create_map, edit_map

Streamable HTTP, no session needed.

## 3. Or use the HTTP API

    GET  ${origin}/api/agent/maps                    list the maps
    POST ${origin}/api/agent/maps                    make one: {"name":"...","area":"...","template":"blank | swimlane | as-is-to-be"}
    GET  ${origin}/api/agent/maps/{id}               the map as JSON, with a readable outline in "text"
    GET  ${origin}/api/agent/maps/{id}?format=text   just the readable outline
    POST ${origin}/api/agent/maps/{id}               change it: {"changes":[ ... ]}

Example:

    curl -X POST ${origin}/api/agent/maps/{id} \\
      -H "Authorization: Bearer $PROCESS_MAPS_KEY" -H "Content-Type: application/json" \\
      -d '{"changes":[{"action":"add","kind":"step","text":"Check the invoice","lane":"AP clerk","after":"Invoice arrives"}]}'

Every answer is JSON with "ok". When "ok" is false, "message" says what to fix.

## Changes

${EDIT_HELP}

## Good practice

${GOOD_PRACTICE}
- A viewer key can read maps but not change them. Archived maps are read only.
`;
}
