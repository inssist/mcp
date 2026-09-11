import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BridgeManifestEntry, BridgeParam } from './protocol.js'

/**
 * Tool advertising has two sources and the fallback order matters:
 *
 *   1. the live manifest a paired extension reports on connect (authoritative)
 *   2. the snapshot bundled with this package (used before anything is paired)
 *
 * The snapshot exists so `npx @inssist/mcp` lists a useful tool set the moment it is added
 * to a harness, with no browser running. Calls against it answer with pairing guidance
 * instead of pretending to work.
 *
 * The snapshot is a build-time copy of `inssist-ext/imports/mcp/mcp-bridge-manifest.json`,
 * refreshed by `scripts/sync-manifest.mjs`.
 */

const SNAPSHOT_PATH = fileURLToPath(new URL('../mcp-bridge-manifest.json', import.meta.url))

export type McpToolShape = {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
  annotations: McpToolAnnotations
}

/** The MCP `ToolAnnotations` hints a harness uses to decide how loudly to ask before a call. */
export type McpToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  openWorldHint: boolean
}

export const loadBundledManifest = (): BridgeManifestEntry[] => {
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as { tools?: unknown }
    if (!Array.isArray(parsed?.tools)) return []
    return parsed.tools as BridgeManifestEntry[]
  } catch {
    // A missing snapshot degrades to "no tools until paired", never to a crash
    return []
  }
}

/**
 * Translates a bridge entry into an MCP tool. Param schemas are declared explicitly in the
 * extension source, so this is a straight mapping with no type inference anywhere.
 */
export const toMcpTool = (entry: BridgeManifestEntry): McpToolShape => {
  const required = entry.params.filter(param => param.required).map(param => param.name)
  // account_info is server-served (no routing/pacing); every other tool takes `instance`, and
  // `instant` too unless it is a local tool (`paced: false`) the pacing queue never touches.
  const params =
    entry.name === ACCOUNT_INFO_TOOL
      ? entry.params
      : entry.paced === false
        ? [...entry.params, INSTANCE_PARAM]
        : [...entry.params, INSTANCE_PARAM, INSTANT_PARAM]

  const annotations = annotate(entry)
  return {
    name: entry.name,
    title: annotations.title,
    description: describe(entry),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(params.map(toProperty)),
      ...(required.length ? { required } : {}),
    },
    annotations,
  }
}

/**
 * Hints derive from what the manifest already knows. `risk` is declared per tool in the
 * extension source (`read` never mutates); `paced` marks the tools that stay inside INSSIST's
 * own storage and never touch Instagram (closed world). Destructiveness is the one fact the
 * manifest does not carry: the spec's default is "may be destructive", so the explicit set
 * below is what lets a harness auto-approve `dm_send` yet always confirm `ig_post_delete`.
 */
export const annotate = (entry: BridgeManifestEntry): McpToolAnnotations => ({
  title: titleOf(entry.name),
  readOnlyHint: entry.risk === 'read',
  destructiveHint: entry.risk !== 'read' && DESTRUCTIVE_TOOLS.has(entry.name),
  openWorldHint: entry.name !== ACCOUNT_INFO_TOOL && entry.paced !== false,
})

/** Tools that delete, overwrite or sever something that exists; everything else only adds. */
const DESTRUCTIVE_TOOLS = new Set([
  'comment_delete',
  'dm_remove',
  'draft_delete',
  'draft_update',
  'downloads_cancel',
  'ig_action', // unfollow
  'ig_block',
  'ig_post_delete',
  'ig_post_edit',
  'profile_update',
])

const TITLE_WORDS: Record<string, string> = { ig: 'Instagram', dm: 'DM', csv: 'CSV', info: 'info' }

/** `ig_fetch_posts` -> "Instagram fetch posts"; the harness shows this next to the raw name. */
const titleOf = (name: string) => {
  const title = name.split('_').map(word => TITLE_WORDS[word] ?? word).join(' ')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** The one tool the server answers itself, by fanning out over every paired browser. */
export const ACCOUNT_INFO_TOOL = 'account_info'

/**
 * Routing param, added by the server rather than declared in the extension: which browser a
 * call lands on is a property of the hub, not of the tool. Omitted, calls go to the active
 * connection, which is the only sensible default with a single browser paired.
 */
const INSTANCE_PARAM: BridgeParam = {
  name: 'instance',
  type: 'string',
  description: `Optional. Browser instance id from ${ACCOUNT_INFO_TOOL}; defaults to the active one.`,
}

/**
 * Pacing bypass, added by the server like `instance`: INSSIST serializes tool calls behind a
 * per-account queue that spaces Instagram activity so a burst does not draw a rate-block. Set
 * this only when the user explicitly asked for an immediate or unspaced action.
 */
const INSTANT_PARAM: BridgeParam = {
  name: 'instant',
  type: 'boolean',
  description:
    "Optional. Skip INSSIST's action pacing and run now — use only when the user asked for an " +
    'unspaced or burst action.',
}

const toProperty = (param: BridgeParam): [string, { type: string; description: string }] => {
  return [param.name, { type: param.type, description: param.description }]
}

/**
 * The description carries the one fact an agent must know before calling that is not in
 * the prose: whether the user pays for this. It is already in the manifest, spelling it
 * out here saves a failed round trip.
 */
const describe = (entry: BridgeManifestEntry) => {
  if (!entry.pro) return entry.description
  return `${entry.description} (Requires INSSIST PRO.)`
}
