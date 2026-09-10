/**
 * The bridge wire protocol: newline-free JSON objects over one WebSocket, every frame
 * tagged with `t`. Deliberately transport agnostic (no WS specifics leak into the shapes)
 * so native messaging can replace the socket without touching either side's logic.
 *
 * Handshake, extension dials the server:
 *
 *   ext -> hello         instanceId, agent build
 *   srv -> server-hello  serverId, version, pid, whether it already holds a token
 *   ext -> auth | pair
 *   srv -> ready | unauthorized
 *   ext -> manifest      live tool list, replaces the bundled snapshot
 *
 * Steady state:
 *
 *   srv -> call          id, tool, params
 *   ext -> result|error  id, payload
 *   srv -> ping          ext -> pong
 *
 * Peers (a second server process on the same machine) speak a small second dialect on the
 * `/peer` path: `peer-hello` in, `peer-state` out on every change, `peer-call` in and
 * `peer-result` / `peer-error` out per call. The hub answers a peer call exactly as it would
 * its own, so every harness on the machine shares one set of browsers.
 *
 * Pairing is automatic: the extension's AI Agents toggle is the user's consent, and on a
 * server's first hello the extension mints a token that both sides persist. The token
 * routes reconnects to the right browser profile; it is not a trust gate. The server
 * records whatever well-formed token it is sent, so any local process able to bind the
 * port can pair itself — accepted under the threat model's local-malware stance (a rogue
 * process on the same machine already owns the session). See mcp-bridge-threat-model.md.
 */

export type BridgeRisk = 'read' | 'write' | 'action'

export type BridgeParam = {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean
}

/** Mirrors `inssist-ext/imports/mcp/mcp-bridge-manifest.json` entries exactly. */
export type BridgeManifestEntry = {
  name: string
  description: string
  params: BridgeParam[]
  pro: boolean
  risk: BridgeRisk
  source: 'unit' | 'actor'
  paced?: boolean // Present (false) only on a local tool; such tools skip the `instant` param
}

export type ExtensionAgent = {
  version: string
  build: string | null
}

// MARK: Extension -> Server
// ============================================================================

export type HelloFrame = { t: 'hello'; v: number; instanceId: string; agent: ExtensionAgent }
export type AuthFrame = { t: 'auth'; token: string }
export type PairFrame = { t: 'pair'; token: string }
export type ManifestFrame = { t: 'manifest'; tools: BridgeManifestEntry[] }
export type ResultFrame = { t: 'result'; id: string; result: unknown }
export type ErrorFrame = { t: 'error'; id: string; error: { message: string; code: string } }
export type PongFrame = { t: 'pong' }

export type ClientFrame =
  | HelloFrame
  | AuthFrame
  | PairFrame
  | ManifestFrame
  | ResultFrame
  | ErrorFrame
  | PongFrame

// MARK: Server -> Extension
// ============================================================================

export type ServerHelloFrame = {
  t: 'server-hello'
  v: number
  serverId: string
  version: string
  pid: number
  paired: boolean
}

export type ReadyFrame = { t: 'ready' }
export type UnauthorizedFrame = { t: 'unauthorized'; reason: string }
export type CallFrame = { t: 'call'; id: string; tool: string; params: Record<string, unknown>; instant?: boolean }
export type PingFrame = { t: 'ping' }

export type ServerFrame = ServerHelloFrame | ReadyFrame | UnauthorizedFrame | CallFrame | PingFrame

// MARK: Peer <-> Hub
// ============================================================================

/** What any harness needs to know about one connected browser profile. */
export type BridgeInstance = {
  instanceId: string
  ready: boolean
  agent: ExtensionAgent
  connectedOn: number
}

export type PeerHelloFrame = { t: 'peer-hello'; v: number; version: string; pid: number }
export type PeerCallFrame = {
  t: 'peer-call'
  id: string
  tool: string
  params: Record<string, unknown>
  instanceId?: string
  instant?: boolean
}
export type PeerClientFrame = PeerHelloFrame | PeerCallFrame

export type PeerStateFrame = {
  t: 'peer-state'
  activeInstanceId: string | null
  manifest: BridgeManifestEntry[] | null
  instances: BridgeInstance[]
  lastRejection: string | null
}
export type PeerResultFrame = { t: 'peer-result'; id: string; result: unknown }
export type PeerErrorFrame = { t: 'peer-error'; id: string; message: string }
export type PeerServerFrame = PeerStateFrame | PeerResultFrame | PeerErrorFrame

/**
 * What `index.ts` talks to, whichever role this process ended up in: the hub that owns the
 * port and the browsers, or a peer relaying through it.
 */
export interface BridgeLink {
  readonly role: 'hub' | 'peer'
  readonly activeInstanceId: string | null
  readonly manifest: BridgeManifestEntry[] | null
  readonly instances: BridgeInstance[]
  readonly lastRejection: string | null
  call(tool: string, params: Record<string, unknown>, instanceId?: string, instant?: boolean): Promise<unknown>
  waitForActive(timeoutMs: number): Promise<boolean>
  close(): void
}

/** Parses a frame without ever throwing: a malformed message must not kill the socket. */
export const parseFrame = (data: string): ClientFrame | null => {
  try {
    const frame = JSON.parse(data) as unknown
    if (!frame || typeof frame !== 'object') return null
    if (typeof (frame as { t?: unknown }).t !== 'string') return null
    return frame as ClientFrame
  } catch {
    return null
  }
}
