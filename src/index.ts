#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveAssetParams, takesAssets } from './assets.js'
import { Bridge } from './bridge.js'
import { BRIDGE_PORT, CONNECT_GRACE_MS, MCP_SERVER_NAME, PACKAGE_NAME, PORT_ENV } from './constants.js'
import { ACCOUNT_INFO_TOOL, loadBundledManifest, toMcpTool } from './manifest.js'
import { PairingStore } from './pairing-store.js'
import type { BridgeLink, BridgeManifestEntry } from './protocol.js'

/**
 * `@inssist/mcp` is two servers in one process:
 *
 *   stdio  <- the agent harness speaks MCP here
 *   ws     <- the INSSIST extension dials in from the browser, loopback only
 *
 * Nothing is proxied to the internet and no credentials are held: a tool call is handed to
 * a browser the user already paired, and whatever it answers comes straight back.
 *
 * Several harnesses at once are fine: the first process to bind the port is the hub, later
 * ones join it as peers and relay through it (see `bridge.ts`).
 */

// stdout belongs to the MCP transport. Every human readable line goes to stderr or it
// corrupts the protocol stream.
const log = (message: string) => process.stderr.write(`[inssist-mcp] ${message}\n`)

const readVersion = () => {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const readPort = () => {
  const raw = process.env[PORT_ENV]
  if (!raw) return BRIDGE_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    log(`Ignoring invalid ${PORT_ENV}="${raw}", using ${BRIDGE_PORT}`)
    return BRIDGE_PORT
  }
  return port
}

const PAIRING_GUIDANCE = [
  'No INSSIST browser is connected to this MCP server yet.',
  'Ask the user to: open instagram.com in Chrome, open the INSSIST menu, click "Connect to AI Agents"',
  'and turn the toggle on. Pairing is automatic; the panel shows "Connected" within a few seconds.',
  'Retry the call once they confirm.',
].join(' ')

const USAGE = [
  `${PACKAGE_NAME}: local MCP server for the INSSIST Chrome extension.`,
  '',
  'Usage: npx @inssist/mcp            start the server (MCP on stdio, bridge on 127.0.0.1:48231;',
  '                                   a second instance joins the first one as a peer)',
  '       npx @inssist/mcp --version  print the version',
  '       npx @inssist/mcp --help     this text',
  '',
  `Environment: ${PORT_ENV}=<port> (bridge port), INSSIST_MCP_HOME=<dir> (pairing file location)`,
  'Docs: https://inssist.com/feature-guides/inssist-mcp-server-for-ai-agents',
].join('\n')

const main = async () => {
  const version = readVersion()
  const flag = process.argv[2]
  if (flag === '--version' || flag === '-v') return void process.stdout.write(`${version}\n`)
  if (flag === '--help' || flag === '-h') return void process.stdout.write(`${USAGE}\n`)

  const port = readPort()
  const pairings = new PairingStore()

  const server = new Server(
    { name: MCP_SERVER_NAME, version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Drives the user's INSSIST Chrome extension over a local bridge. Tools act on the browser " +
        'profile the user paired, using their existing Instagram session.',
    },
  )

  const bridge = new Bridge({
    port,
    version,
    pairings,
    log,
    // A browser connecting or leaving changes the advertised tool set, so tell the harness
    // to re-list rather than leaving it on the bundled snapshot
    onToolsChanged: () => void server.sendToolListChanged().catch(() => {}),
  })

  await startBridge(bridge, port)

  const bundled = loadBundledManifest()
  log(`Bundled manifest: ${bundled.length} tools`)
  log(`Pairings file: ${pairings.filePath}`)

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = bridge.manifest ?? bundled
    return { tools: tools.map(toMcpTool) }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name
    const params = (request.params.arguments ?? {}) as Record<string, unknown>
    return await callTool(bridge, bundled, name, params)
  })

  await server.connect(new StdioServerTransport())
  log(`Ready. MCP on stdio, role: ${bridge.role}`)

  const shutdown = () => {
    bridge.close()
    process.exit(0)
  }

  // The harness owns this process. The SDK transport closes on a stdin error but not on a plain
  // end-of-stream, and the WebSocket server would otherwise keep the event loop (and the port)
  // alive behind a client that is gone, so both paths lead to the same exit
  server.onclose = shutdown
  process.stdin.on('end', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * The bridge picks its role itself (hub if the port is free, peer if another instance holds
 * it). What is left to fail here is a port owned by something that is not `@inssist/mcp`, or
 * a bind error, and neither has a useful degraded mode: exit with the one hint that helps.
 */
const startBridge = async (bridge: Bridge, port: number) => {
  try {
    await bridge.start()
  } catch (error) {
    log(`Failed to start the bridge on 127.0.0.1:${port}: ${String(error)}`)
    log(`If another program owns that port, set ${PORT_ENV} to a free one here and in the INSSIST extension.`)
    process.exit(1)
  }
}

const callTool = async (
  bridge: BridgeLink,
  bundled: BridgeManifestEntry[],
  name: string,
  params: Record<string, unknown>,
) => {
  const entry = (bridge.manifest ?? bundled).find(tool => tool.name === name)
  if (!entry) return errorResult(`Unknown tool: "${name}"`)

  // A harness often calls within seconds of starting this process, while the extension is
  // still in its reconnect backoff: give it that window before declaring nobody home.
  // Unpaired after that is the common first-run state, not a failure worth a stack trace:
  // answer with the exact steps so the agent can relay them. A browser that was turned away
  // (protocol skew) is the one case where the steps differ, so that message wins while fresh
  if (!bridge.activeInstanceId) await bridge.waitForActive(CONNECT_GRACE_MS)
  if (!bridge.activeInstanceId) return errorResult(bridge.lastRejection ?? PAIRING_GUIDANCE)

  // `instance` and `instant` are the hub's own params, stripped before the call: `instance`
  // routes to a browser, `instant` bypasses the extension's pacing queue. Neither is a tool arg.
  const { instance, instant, ...rest } = params
  const instanceId = typeof instance === 'string' && instance ? instance : undefined
  const bypassQueue = instant === true || instant === 'true'
  if (instanceId && !bridge.instances.some(instance => instance.ready && instance.instanceId === instanceId)) {
    const known = bridge.instances.filter(instance => instance.ready).map(instance => instance.instanceId)
    return errorResult(`Unknown instance "${instanceId}". Connected instances: ${known.join(', ') || 'none'}.`)
  }

  try {
    // Local file paths only mean something in this process, so they become bytes here,
    // before the params reach a browser that has no filesystem of its own
    const args = takesAssets(entry) ? await resolveAssetParams(rest) : rest

    const result =
      name === ACCOUNT_INFO_TOOL
        ? await collectAccountInfo(bridge)
        : await bridge.call(name, args, instanceId, bypassQueue)

    // A PRO-gated call answers with an upsell instead of running. That is a message for
    // the user, not a malfunction, so it comes back as plain text and not an error
    const upsell = readUpsell(result)
    if (upsell) return { content: [{ type: 'text' as const, text: upsell }] }

    return { content: [{ type: 'text' as const, text: stringify(result) }] }
  } catch (error) {
    return errorResult((error as Error).message || String(error))
  }
}

const readUpsell = (result: unknown) => {
  if (!result || typeof result !== 'object') return null
  const payload = result as { upsell?: unknown; message?: unknown }
  if (payload.upsell !== true) return null
  return typeof payload.message === 'string' ? payload.message : null
}

/**
 * `account_info` is the one tool the hub answers rather than forwards: an extension only knows
 * its own browser profile, and the point of the tool is the list of all of them. Each paired
 * browser is asked for its own half, and one profile failing must not hide the others.
 */
const collectAccountInfo = async (bridge: BridgeLink) => {
  const active = bridge.activeInstanceId
  const ready = bridge.instances.filter(instance => instance.ready)

  const instances = await Promise.all(
    ready.map(async instance => {
      const head = {
        instance: instance.instanceId,
        active: instance.instanceId === active,
        inssistVersion: instance.agent.version,
        connectedOn: new Date(instance.connectedOn).toISOString(),
      }

      try {
        const account = await bridge.call(ACCOUNT_INFO_TOOL, {}, instance.instanceId)
        return { ...head, ...(account as Record<string, unknown>) }
      } catch (error) {
        return { ...head, error: (error as Error).message || String(error) }
      }
    }),
  )

  return { active, count: instances.length, instances }
}

const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

const stringify = (value: unknown) => {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

main().catch(error => {
  log(`Fatal: ${String(error)}`)
  process.exit(1)
})
