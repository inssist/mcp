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
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
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

  return {
    name: entry.name,
    description: describe(entry),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(params.map(toProperty)),
      ...(required.length ? { required } : {}),
    },
  }
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
