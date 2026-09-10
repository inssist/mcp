import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'
import type { BridgeManifestEntry } from './protocol.js'

/**
 * Media ingestion for publishing tools.
 *
 * An agent names media the way it names anything else: a path on the machine it runs on,
 * or a link. Splitting the two follows who can actually reach them:
 *
 *   local path -> resolved here. Only this process shares a filesystem with the agent;
 *                 the extension has none, so the bytes travel inline as base64.
 *   http(s) url -> passed through untouched. The extension downloads it itself, with the
 *                 browser's own network stack and the user's own connection.
 *
 * Base64 inside the call params is the whole transport at v1: all assets ride in the one
 * `call` frame the server sends to the extension. That frame is a single JSON string, and
 * `JSON.stringify` throws above V8's max string length (~512 MB), so the total cap exists to
 * keep the base64 (~1.33x the bytes) comfortably under that ceiling, not to ration media.
 * A full 20-slide carousel of large photos or a reel fits well within it; genuinely huge
 * videos are the case that will justify a real per-asset binary frame later.
 */

/** Per file, before base64 expansion. Sized for a reel-length video, not just a photo. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024

/**
 * Across one call, in raw bytes like the per-file cap. A 20-slide carousel at ~5 MB each is
 * 100 MB and must pass; the ceiling is the JSON-string limit on the combined frame (base64 is
 * ~1.33x this), so this leaves headroom under it while still catching an agent that would
 * inline gigabytes by mistake.
 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024

/** Mirrors `later.mimeTypes` in the extension's fusion config: what Later accepts. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/** What the extension receives in place of each `assets` entry. */
export type ResolvedAsset =
  | { url: string }
  | { name: string; mime: string; base64: string }

const ASSETS_PARAM = 'assets'

/** True when this tool takes media, i.e. when the params need a pass through here. */
export const takesAssets = (entry: BridgeManifestEntry) => {
  return entry.params.some(param => param.name === ASSETS_PARAM)
}

/**
 * Replaces the `assets` array with resolved entries. Anything else in the params is left
 * exactly as the agent sent it.
 */
export const resolveAssetParams = async (params: Record<string, unknown>) => {
  const assets = params[ASSETS_PARAM]
  if (assets === undefined || assets === null) return params

  const list = Array.isArray(assets) ? assets : [assets]
  if (list.length === 0) return params

  let total = 0
  const resolved: ResolvedAsset[] = []

  for (const asset of list) {
    const item = await resolveAsset(asset)
    if ('base64' in item) {
      total += rawBytes(item.base64)
      if (total > MAX_TOTAL_BYTES) {
        throw new Error(
          `Local assets add up to more than ${mb(MAX_TOTAL_BYTES)} in one call. ` +
            'Split them across several posts, or host them and pass http(s) urls instead.',
        )
      }
    }
    resolved.push(item)
  }

  return { ...params, [ASSETS_PARAM]: resolved }
}

const resolveAsset = async (asset: unknown): Promise<ResolvedAsset> => {
  if (typeof asset !== 'string' || !asset.trim()) {
    throw new Error('Each `assets` entry must be a local file path or an http(s) url')
  }

  const value = asset.trim()
  if (/^https?:\/\//i.test(value)) return { url: value }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error(`Unsupported asset "${value}": only local file paths and http(s) urls are accepted`)
  }

  return await readLocalAsset(value)
}

const readLocalAsset = async (value: string): Promise<ResolvedAsset> => {
  const path = expand(value)
  const extension = extname(path).toLowerCase()
  const mime = MIME_BY_EXTENSION[extension]
  if (!mime) {
    const supported = Object.keys(MIME_BY_EXTENSION).join(', ')
    throw new Error(`Unsupported asset type "${extension || path}". Supported: ${supported}`)
  }

  const info = await stat(path).catch(() => null)
  if (!info) throw new Error(`Asset not found: ${path}`)
  if (!info.isFile()) throw new Error(`Asset is not a file: ${path}`)
  if (info.size === 0) throw new Error(`Asset is empty: ${path}`)
  if (info.size > MAX_ASSET_BYTES) {
    throw new Error(
      `Asset ${path} is ${mb(info.size)}, over the ${mb(MAX_ASSET_BYTES)} limit for a local file. ` +
        'Host it and pass an http(s) url instead, which the browser downloads directly.',
    )
  }

  const bytes = await readFile(path)
  return { name: path.split(/[/\\]/).pop() ?? 'asset', mime, base64: bytes.toString('base64') }
}

/** `~` is what a user types and an agent copies, and nothing below expands it for us. */
const expand = (value: string) => {
  const path = value.startsWith('~/') || value === '~' ? value.replace('~', homedir()) : value
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/** Base64 length back to the byte count it encodes, so both caps measure the same thing. */
const rawBytes = (base64: string) => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
