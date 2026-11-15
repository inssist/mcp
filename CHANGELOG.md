# Changelog

## 2.2.0 (2026-11-15)

- `draft_create` / `draft_update` take `linkText` to label a story link sticker (up to 60 chars,
  defaults to the URL's domain).
- `ig_action` and the comment tools say why a call did not go through: `done: false` now comes
  with a `reason`, e.g. `comments_disabled`, not only on rate limits.
- `ig_fetch_posts` reports whether each post is pinned, has comments turned off or is liked by
  you, and lists pinned posts first.
- `draft_schedule` describes Cloud Scheduling: `draft_get` shows whether a post publishes from
  the cloud, with no Chrome needed, or locally.

## 2.1.1 (2026-10-14)

- `dm_send` takes `force` to send a new conversation past the daily cold-DM limit, for when the
  user explicitly asks to. The limit's decline message now mentions it.

## 2.1.0 (2026-10-07)

- New tool `ig_hashtag_posts`: a hashtag's posts page by page, with owners and slide counts.
- New tool `draft_preview`: the post rendered as it will publish, returned as an image. Needs
  this server version; older servers are not offered it.
- `draft_create` / `draft_update` gained `sticker`, `linkSticker` and `locationSticker` to place
  and style story stickers; `draft_create` takes `at` to schedule in the same call.
- `account_info` reports the browser `timeZone` that times without an offset are read in, and
  `scheduledFor` is given in that time zone with its offset; `draft_update` reports the place a
  `location` matched.

## 2.0.0 (2026-09-22)

Two new tools, seven fields for controlling scheduling, and `dm_send` can now facilitate outreach,
reaching out people you have never messaged.

- New tool `events_check`: everything new since a cursor (DMs, requests, comments, likes,
  follows, mentions) in one non-blocking request, so an agent can watch an account on a schedule.
- New tool `follower_remove`: drops an account from your followers without blocking it (the
  request Instagram's own "Remove" button sends).
- `dm_send` starts cold conversations: a username you have never messaged now gets a new thread
  that lands in their message requests, capped per day. It used to refuse.
- `draft_create` / `draft_update` gained `collaborators`, `closeFriends`, `linkUrl`,
  `stickerText`, `hideLikes`, `disableComments` and `shareToFeed`; `mentions` is documented as
  photo tags, which is not the same as writing @name in the caption.
- MCP-scoped PRO now got trial: enabling the extension's **AI Agents** toggle unlocks the PRO
  write tools for 7 days. `account_info` reports the remainder as `proTrialDaysLeft`.
- Rate-limited writes answer `done: false` rather than throwing, and reported back to Agent
  appropriately.
- `dm_read` / `dm_list` / `dm_requests` describe their paging honestly: `dm_read` returns the
  newest `limit` messages with `has_more`, the two list tools return Instagram's single page.
- Tool snapshot: 60 tools.

## 1.0.2 (2026-09-11)

- Fix: the server exited when a harness restarted it while the previous process was still
  releasing the port (Claude Desktop does this in the same millisecond), so the new process
  saw EADDRINUSE and then ECONNRESET on the peer dial. `start()` now retries for up to 5 s.

## 1.0.1 (2026-09-11)

- Tool annotations (`title`, `readOnlyHint`, `destructiveHint`, `openWorldHint`) on every tool,
  so harnesses can auto-approve reads and confirm deletes.

## 1.0.0 (2026-09-10)

First public release.

- Local stdio MCP server + loopback WebSocket bridge to the INSSIST Chrome extension.
- 58 tools across Account, Profile, Read data, Engagement, Comments, Direct messages, Publishing,
  Insights, Audience and Downloads; free reads, PRO writes.
- Automatic pairing: the extension's **AI Agents** toggle is the consent, tokens route reconnects.
- Bundled tool snapshot so harnesses list tools before a browser connects.
- Per-account pacing queue in the extension; `instant` param to bypass it on request.
- Protocol version check on both ends with an actionable message on mismatch.
- `--version` / `--help`; the server exits with the harness (no orphaned port).
- Several harnesses at once: the first process is the hub, later ones join it as peers and
  relay through it; a peer takes over the port when the hub's harness closes.
- A tool call fired right after startup waits up to 15 s for the extension's reconnect
  before answering "not connected".
