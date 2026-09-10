#!/usr/bin/env node
import { copyFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Copies the extension's generated bridge manifest into this package, so `npx @inssist/mcp`
 * can advertise tools before any browser is paired.
 *
 * Two homes, two behaviours:
 *   - in the INSSIST monorepo the extension source is the single source of truth (written by
 *     `inssist-ext/scripts/paralayer.ts` on the extension build), so the copy is refreshed on
 *     every `npm run build` and a manifest without tools is a hard error;
 *   - in the public `inssist/mcp` repo there is no extension source: the committed snapshot
 *     *is* the input, and this script is a no-op that says so.
 */

const source = fileURLToPath(new URL('../../inssist-ext/imports/mcp/mcp-bridge-manifest.json', import.meta.url))
const target = fileURLToPath(new URL('../mcp-bridge-manifest.json', import.meta.url))

if (!existsSync(source)) {
  if (!existsSync(target)) throw new Error(`No bridge manifest: neither ${source} nor ${target} exists`)
  const bundled = JSON.parse(await readFile(target, 'utf-8'))
  process.stdout.write(`Standalone checkout: keeping the committed snapshot (${bundled.tools?.length ?? 0} tools)\n`)
  process.exit(0)
}

const manifest = JSON.parse(await readFile(source, 'utf-8'))
if (!Array.isArray(manifest?.tools)) throw new Error(`Bridge manifest at ${source} has no tools array`)

await copyFile(source, target)
process.stdout.write(`Synced ${manifest.tools.length} bridge tools into ${target}\n`)
