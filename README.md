# @inssist/mcp

[![npm](https://img.shields.io/npm/v/@inssist/mcp)](https://www.npmjs.com/package/@inssist/mcp)
[![MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.inssist%2Finssist--mcp-blue)](https://registry.modelcontextprotocol.io/?search=inssist)
[![license](https://img.shields.io/npm/l/@inssist/mcp)](./LICENSE)

The MCP server that lets an AI agent work inside **your own logged-in Instagram session**,
through the [INSSIST](https://inssist.com) Chrome extension.

Every other Instagram MCP wraps the Graph API: business accounts only, no Stories, no music, no
DMs, only what Meta chooses to expose. This one drives the browser you are already signed into,
so Claude Code, Codex, Cursor or Claude Desktop can read profiles and DMs, publish and schedule
posts, reels and stories with music, pull insights and audience reports, and download media, on
a personal, creator or business account alike.

Nothing is proxied through a cloud and no Instagram credentials are ever held: the server hands
each tool call to the extension over loopback, and the extension answers from the browser.

```
Claude Code / Codex / Cursor / Claude Desktop
  │  stdio (MCP)
  ▼
@inssist/mcp                    ← this package, runs on your machine
  │  ws://127.0.0.1:48231
  ▼
INSSIST extension (Chrome)
  │
  ▼
Instagram, in your own session
```

## Requirements

- Chrome (or another Chromium browser) with [INSSIST](https://chromewebstore.google.com/detail/inssist-web-client-for-in/bcocdbombenodlegijagbhdjbifpiijp) installed and Instagram open and logged in.
- Node.js 22 or newer (`npx` comes with it).
- An MCP client. Any harness that can launch a stdio server works.

## Install

Register the server with your agent. It downloads and starts the server by itself; there is
nothing to run by hand.

**Claude Code**

```sh
claude mcp add inssist -- npx -y @inssist/mcp
```

**Codex**

```sh
codex mcp add inssist -- npx -y @inssist/mcp
```

**Claude Desktop, including Cowork**: download
[inssist-mcp.mcpb](https://github.com/inssist/mcp/releases/latest/download/inssist-mcp.mcpb)
and double-click it. One step, runs on Claude's built-in Node.js, no terminal needed.

**Cursor, Windsurf, Gemini CLI and any other client**: add this to its MCP config (Cursor:
`.cursor/mcp.json`):

```json
{ "mcpServers": { "inssist": { "command": "npx", "args": ["-y", "@inssist/mcp"] } } }
```

## Connect the browser

1. In Chrome, open **instagram.com** and click the INSSIST menu.
2. Click **Connect to AI Agents** and turn the toggle on.
3. The panel shows **Connected** within a few seconds.

Pairing is automatic: the toggle is the consent. The extension dials the server, both sides
store a token for silent reconnects, and turning the toggle off disconnects and stops all
retries. Several Chrome profiles can connect to the same server; each shows up as an
`instance` in `account_info`.

Several agents at once are fine too. Each harness starts its own `@inssist/mcp` process; the
first one to bind the port becomes the hub, later ones join it as peers and relay through it,
so Claude Code in two terminals, Claude Desktop and Cursor all share the same browsers. When the
hub's harness closes, one of the peers takes the port over and the extension reconnects to it.

## Try it

```
Who am I logged in as, and how many followers do I have?
Show me the last 5 posts from @nasa with their like counts.
List my unread DMs and draft a reply to the first one. Don't send it yet.
Schedule /Users/me/reel.mp4 as a reel for tomorrow 9am with a caption about spring, and add a trending track.
Run an unfollowers scan and tell me who left this week.
Download the last 20 posts from @natgeo to my machine.
```

## Tools

58 tools, grouped the way the extension's **Tools & features** panel groups them. **PRO** marks
tools that need an [INSSIST PRO](https://inssist.com/#pricing) subscription; everything else is
free, with no rate limit beyond INSSIST's own pacing. A PRO tool called without a subscription
answers with a short message and an upgrade link instead of failing, so the agent can relay it.

| Group           | Tools                                                                                                                         |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------|
| Account         | `account_info`, `account_switch`                                                                                              |
| Profile         | `profile_update`, `note_set`                                                                                                  |
| Read data       | `ig_fetch_profile`, `ig_fetch_posts`, `ig_fetch_post`, `ig_fetch_stories`, `ig_fetch_saved`, `ig_search`                      |
| Engagement      | `story_viewers`, `notifications_list`, `follow_requests_list`                                                                 |
| Comments        | `comments_list`                                                                                                               |
| Direct messages | `dm_list`, `dm_requests`, `dm_read`, `dm_send`, `dm_mark_seen`, `dm_accept`, `dm_remove`                                      |
| Publishing      | `draft_create`, `draft_schedule`, `draft_publish`, `draft_get`, `draft_update`, `draft_delete`, `draft_list`, `draft_reorder` |
| Posting         | `ig_post_edit`, `ig_post_delete`, `location_search`, `music_search`                                                           |
| Insights        | `insights_collect`, `insights_report`                                                                                         |
| Audience        | `unfollowers_scan` / `_report` / `_export`, `antibot_scan` / `_report` / `_export`, `peers_scan` / `_report` / `_export`      |
| Downloads       | `downloads_start`, `downloads_status`, `downloads_cancel`                                                                     |

A few shapes worth knowing:

- **`draft_*` vs `ig_post_*`.** Drafts live in INSSIST's own publishing queue (a draft can be a
  post, reel, story or carousel; `type` says which). `ig_post_edit` / `ig_post_delete` act on
  posts already live on Instagram.
- **Start, then poll.** Long jobs run in the background and are visible in INSSIST's UI:
  `insights_collect` → `insights_report`, `unfollowers_scan` → `unfollowers_report`,
  `antibot_scan` → `antibot_report`, `peers_scan` → `peers_report`,
  `downloads_start` → `downloads_status`.
- **`*_export`** writes the full list to a CSV via Chrome's downloads and returns the path, for
  lists too large to stream into an agent's context.
- **`Assets`** for `draft_create` are local file paths (the server reads them) or http(s) URLs
  (the extension downloads them). Up to 100 MB per file, 200 MB per call.
- **`instance`** (every tool but `account_info`): which connected browser profile to use.
  Defaults to the active one.
- **`instant`** (tools that hit Instagram): INSSIST spaces agent calls a few seconds apart on
  one per-account queue so a burst does not draw a rate block. `instant: true` skips the queue;
  agents should use it only when you asked for an immediate action. A call that would wait
  longer than ~50 s is refused at once with `busy: true` and a `retryAfterMs`.

Before a browser connects, the server advertises a snapshot of the tool list bundled with the
package, so a harness can list tools with nothing running. Calls against it answer with the
connection steps. Once the extension connects, its live list replaces the snapshot and the
client gets a `tools/list_changed` notification.

## Privacy

Everything runs on your machine. The server binds `127.0.0.1`, accepts connections only from
`chrome-extension://` origins, and stores one file, `~/.inssist/mcp-pairings.json` (mode
`0600`), holding its own id and one pairing token per browser profile. The extension sends
INSSIST its usual anonymous usage events, including the name of each tool an agent calls, never
the arguments or results. Instagram traffic is the browser's own. See the
[privacy policy](https://inssist.com/privacy).

## Configuration

| Variable           | Default      | Meaning                                                            |
|--------------------|--------------|--------------------------------------------------------------------|
| `INSSIST_MCP_PORT` | `48231`      | Loopback port the extension dials (change it in the extension too) |
| `INSSIST_MCP_HOME` | `~/.inssist` | Directory holding `mcp-pairings.json`                              |

`npx @inssist/mcp --version` and `--help` are also available.

## Troubleshooting

- **"Failed to start the bridge on 127.0.0.1:48231."** Some other program owns that port
  (another `@inssist/mcp` would have been joined, not refused). Find it with
  `lsof -nP -i :48231` (macOS/Linux), or set `INSSIST_MCP_PORT` to a free port here and in the
  extension.
- **The panel stays on "Waiting…".** The server is not running. Make sure your MCP client has
  started it (most start servers lazily, on the first tool call or when you open the session)
  and that nothing else answers on the port. Turn the toggle off and on to reconnect at once.
- **Tools answer "No INSSIST browser is connected".** The toggle is off, Instagram is not open
  in that Chrome profile, or the extension is still connecting. Check the panel says Connected.
- **A protocol-version message.** The extension and the server disagree on the wire format.
  Update whichever the message names: the extension at `chrome://extensions` → Update, the
  server with `npx @inssist/mcp@latest` (or clear the npx cache) and restart the harness.
- **A PRO tool returns an upgrade message.** Expected without a subscription; the agent will
  relay the link.

## Development

```sh
npm install
npm run build               # compile (in the INSSIST monorepo this also refreshes the tool snapshot)
npm test                    # build + unit tests (node --test)
node scripts/smoke.mjs 60   # spawn the built server, list tools, call account_info
```

`mcp-bridge-manifest.json` is the tool snapshot, generated from the extension source and
committed here on each release. It is not hand-edited.

## Security and support

Report vulnerabilities to **inssist@slashed.io** (see [SECURITY.md](./SECURITY.md)). Support
and questions: the same address, or [inssist.com/support](https://inssist.com/support).
[MIT](./LICENSE).
