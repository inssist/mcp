import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  BRIDGE_HOST,
  CALL_TIMEOUT_MS,
  EXTENSION_ORIGIN_PREFIX,
  HANDSHAKE_TIMEOUT_MS,
  KEEPALIVE_MS,
  PACKAGE_NAME,
  PEER_PATH,
  PROTOCOL_VERSION,
} from './constants.js'
import type { PairingStore } from './pairing-store.js'
import {
  parseFrame,
  type BridgeInstance,
  type BridgeLink,
  type BridgeManifestEntry,
  type ExtensionAgent,
  type HelloFrame,
  type PeerClientFrame,
  type PeerServerFrame,
  type ServerFrame,
} from './protocol.js'

/**
 * The WebSocket half of the bridge: one loopback server, many browser profiles, and any
 * number of peer processes.
 *
 * Every connected extension gets a `Connection` keyed by its per-profile instance id, so
 * a user running INSSIST in several Chrome profiles ends up with several routable targets
 * behind one MCP process. Routing is deliberately dumb (first ready connection wins) unless a
 * call names an `instance`; `account_info` lists them so an agent can pick.
 *
 * Peers are other `@inssist/mcp` processes (a second Claude Code window, Claude Desktop next
 * to Cursor) that found the port taken. They dial `/peer`, receive this hub's state on every
 * change, and relay their tool calls here, so one set of browsers serves every harness.
 */

export type Connection = {
  instanceId: string
  agent: ExtensionAgent
  socket: WebSocket
  manifest: BridgeManifestEntry[]
  ready: boolean
  connectedOn: number
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type BridgeHubOptions = {
  port: number
  version: string
  pairings: PairingStore
  onToolsChanged: () => void
  log: (message: string) => void
}

export class BridgeHub implements BridgeLink {
  readonly role = 'hub' as const
  private readonly options: BridgeHubOptions
  private readonly connections = new Map<string, Connection>()
  private readonly peers = new Set<WebSocket>()
  private readonly pending = new Map<string, PendingCall>()
  private wss: WebSocketServer | null = null
  private keepalive: NodeJS.Timeout | null = null

  /**
   * Why the most recent browser was turned away, for the agent. The harness never sees the
   * extension's side, so a protocol mismatch would otherwise read as "not paired yet" and the
   * user would be told to flip a toggle that is already on. Cleared once any browser is ready.
   */
  private rejection: string | null = null

  private readonly readyWaiters = new Set<() => void>()

  get lastRejection() {
    return this.rejection
  }

  private set lastRejection(value: string | null) {
    if (this.rejection === value) return
    this.rejection = value
    this.broadcastState()
  }

  constructor(options: BridgeHubOptions) {
    if (!options?.pairings) throw new Error('BridgeHub: pairings store is required')
    this.options = options
  }

  /**
   * Binds 127.0.0.1 only. A busy port means another `@inssist/mcp` already owns the bridge;
   * the caller then joins it as a peer (see `bridge.ts`) rather than running a second server
   * no extension would ever reach. Rejects with the bind error so the caller can tell.
   */
  async start() {
    const wss = new WebSocketServer({
      host: BRIDGE_HOST,
      port: this.options.port,
      verifyClient: (info: { origin: string | undefined; req: IncomingMessage }) =>
        this.verifyClient(info.origin, info.req.url),
    })
    this.wss = wss

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })

    wss.on('error', error => this.options.log(`WebSocket server error: ${String(error)}`))
    wss.on('connection', (socket, request) => {
      if (request.url === PEER_PATH) this.onPeer(socket)
      else this.onConnection(socket)
    })
    this.keepalive = setInterval(() => this.pingAll(), KEEPALIVE_MS)
  }

  /** The port actually bound (differs from the option only when it asked for 0, in tests). */
  get port() {
    const address = this.wss?.address()
    return address && typeof address === 'object' ? address.port : this.options.port
  }

  get list() {
    return [...this.connections.values()]
  }

  /** The connection tools route to until an explicit target param exists. */
  get active(): Connection | null {
    return this.list.find(connection => connection.ready) ?? null
  }

  get activeInstanceId() {
    return this.active?.instanceId ?? null
  }

  get instances(): BridgeInstance[] {
    return this.list.map(({ instanceId, ready, agent, connectedOn }) => ({ instanceId, ready, agent, connectedOn }))
  }

  /**
   * Resolves as soon as any browser is ready, or after `timeoutMs`. Lets the first tool call
   * of a session ride out the extension's reconnect backoff instead of failing at once.
   */
  waitForActive(timeoutMs: number) {
    if (this.active) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const done = (ready: boolean) => {
        clearTimeout(timer)
        this.readyWaiters.delete(done as () => void)
        resolve(ready)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.readyWaiters.add(() => done(true))
    })
  }

  /** Live tool list of the active browser, or null while nothing is paired. */
  get manifest(): BridgeManifestEntry[] | null {
    const active = this.active
    if (!active || !active.manifest.length) return null
    return active.manifest
  }

  /**
   * Sends one tool call to a paired extension and resolves with whatever it reports back.
   * Correlation is by generated id, so several calls may be in flight on one socket.
   */
  async call(tool: string, params: Record<string, unknown>, instanceId?: string, instant?: boolean) {
    if (!tool) throw new Error('call: tool name is required')

    const connection = instanceId ? this.connections.get(instanceId) : this.active
    if (!connection || !connection.ready) throw new Error('No paired INSSIST extension is connected')

    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Tool "${tool}" timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s`))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      this.send(connection.socket, { t: 'call', id, tool, params, instant })
    })
  }

  close() {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    this.readyWaiters.forEach(wake => wake())
    this.pending.forEach(call => {
      clearTimeout(call.timer)
      call.reject(new Error('Bridge is shutting down'))
    })
    this.pending.clear()
    this.peers.forEach(peer => peer.close())
    this.peers.clear()
    this.wss?.close()
    this.wss = null
  }

  // MARK: Connection lifecycle
  // ============================================================================

  /**
   * A web page cannot set `Origin`, so refusing everything that is not an extension keeps
   * `http://evil.example` off a port it can otherwise reach. Local processes can forge the
   * header freely, which is exactly why pairing exists on top of this. Peers are the one
   * exception: a Node client sends no `Origin` at all, and a browser always sends one, so
   * "no origin on `/peer`" can only be another local process (accepted by the threat model).
   */
  private verifyClient(origin: string | undefined, url: string | undefined) {
    if (url === PEER_PATH) return !origin
    if (origin?.startsWith(EXTENSION_ORIGIN_PREFIX)) return true
    this.options.log(`Rejected connection from origin: ${origin ?? '(none)'}`)
    return false
  }

  private onConnection(socket: WebSocket) {
    let instanceId: string | null = null

    // An extension that never finishes the handshake, or a stranger that opened the port
    // and went quiet, must not hold a socket forever
    const handshakeTimer = setTimeout(() => {
      if (!instanceId || !this.connections.get(instanceId)?.ready) socket.close()
    }, HANDSHAKE_TIMEOUT_MS)

    socket.on('message', data => {
      const frame = parseFrame(String(data))
      if (!frame) return
      instanceId = this.onFrame(socket, frame, instanceId)
    })

    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      if (!instanceId) return
      if (this.connections.get(instanceId)?.socket !== socket) return
      this.connections.delete(instanceId)
      this.options.log(`Extension disconnected: ${instanceId}`)
      this.changed()
    })

    socket.on('error', error => this.options.log(`Socket error: ${String(error)}`))
  }

  /** Returns the instance id the socket is now bound to, so `onConnection` can track it. */
  private onFrame(socket: WebSocket, frame: ReturnType<typeof parseFrame>, instanceId: string | null) {
    if (!frame) return instanceId

    if (frame.t === 'hello') return this.onHello(socket, frame)
    if (frame.t === 'pong') return instanceId
    if (!instanceId) return instanceId // Everything below needs a hello first

    if (frame.t === 'auth') this.onAuth(socket, instanceId, frame.token)
    if (frame.t === 'pair') this.onPair(socket, instanceId, frame.token)
    if (frame.t === 'manifest') this.onManifest(instanceId, frame.tools)
    if (frame.t === 'result') this.settle(frame.id, frame.result, null)
    if (frame.t === 'error') this.settle(frame.id, null, frame.error?.message ?? 'Tool call failed')

    return instanceId
  }

  private onHello(socket: WebSocket, frame: HelloFrame) {
    const { instanceId, agent } = frame
    if (!instanceId || typeof instanceId !== 'string') {
      socket.close()
      return null
    }

    // Both sides check the protocol version (the extension does the same on server-hello), so
    // whichever is older gets a clear message instead of a handshake that never completes
    if (frame.v !== PROTOCOL_VERSION) {
      const reason = protocolSkew(frame.v, agent?.version)
      this.lastRejection = reason
      this.options.log(reason)
      this.send(socket, { t: 'unauthorized', reason })
      socket.close()
      return null
    }

    // A reconnect after an unclean close leaves the old entry behind: replace it
    const previous = this.connections.get(instanceId)
    if (previous && previous.socket !== socket) previous.socket.close()

    this.connections.set(instanceId, {
      instanceId,
      agent: agent ?? { version: 'unknown', build: null },
      socket,
      manifest: [],
      ready: false,
      connectedOn: Date.now(),
    })

    this.send(socket, {
      t: 'server-hello',
      v: PROTOCOL_VERSION,
      serverId: this.options.pairings.serverId,
      version: this.options.version,
      pid: process.pid,
      paired: !!this.options.pairings.getToken(instanceId),
    })

    return instanceId
  }

  private onAuth(socket: WebSocket, instanceId: string, token: string) {
    const known = this.options.pairings.getToken(instanceId)
    if (!known || !token || !tokensEqual(known, token)) {
      this.send(socket, { t: 'unauthorized', reason: 'Pairing token is unknown or stale' })
      socket.close()
      return
    }

    this.markReady(socket, instanceId, 'authenticated')
  }

  /**
   * The extension mints the token on first hello (the AI Agents toggle is the consent), so
   * this side only records it — any well-formed token from any local client is accepted;
   * the token routes reconnects, it does not establish trust. Overwriting an existing token
   * is intentional: it is how a browser that lost its half of the pair recovers, and it can
   * only ever replace its own profile's entry.
   */
  private onPair(socket: WebSocket, instanceId: string, token: string) {
    if (!token || typeof token !== 'string' || token.length < 16) {
      this.send(socket, { t: 'unauthorized', reason: 'Pairing token is malformed' })
      socket.close()
      return
    }

    this.options.pairings.setToken(instanceId, token)
    this.markReady(socket, instanceId, 'paired')
  }

  private markReady(socket: WebSocket, instanceId: string, reason: string) {
    const connection = this.connections.get(instanceId)
    if (!connection) return
    connection.ready = true
    this.rejection = null
    this.send(socket, { t: 'ready' })
    this.readyWaiters.forEach(wake => wake())
    this.changed()
    this.options.log(`Extension ${reason}: ${instanceId} (INSSIST ${connection.agent.version})`)
  }

  private onManifest(instanceId: string, tools: BridgeManifestEntry[]) {
    const connection = this.connections.get(instanceId)
    if (!connection || !Array.isArray(tools)) return
    connection.manifest = tools
    this.options.log(`Live manifest from ${instanceId}: ${tools.length} tools`)
    this.changed()
  }

  // MARK: Peers
  // ============================================================================

  private onPeer(socket: WebSocket) {
    this.peers.add(socket)
    this.options.log(`Peer joined (${this.peers.size} total)`)

    socket.on('message', data => {
      const frame = parseFrame(String(data)) as PeerClientFrame | null
      if (!frame) return
      if (frame.t === 'peer-hello') this.sendPeer(socket, this.state())
      if (frame.t === 'peer-call') void this.onPeerCall(socket, frame)
    })

    socket.on('close', () => {
      this.peers.delete(socket)
      this.options.log(`Peer left (${this.peers.size} total)`)
    })

    socket.on('error', error => this.options.log(`Peer socket error: ${String(error)}`))
  }

  /** A peer's call is this hub's call: same routing, same timeout, same error text. */
  private async onPeerCall(socket: WebSocket, frame: PeerClientFrame & { t: 'peer-call' }) {
    try {
      const result = await this.call(frame.tool, frame.params ?? {}, frame.instanceId, frame.instant)
      this.sendPeer(socket, { t: 'peer-result', id: frame.id, result })
    } catch (error) {
      this.sendPeer(socket, { t: 'peer-error', id: frame.id, message: (error as Error).message || String(error) })
    }
  }

  private state(): PeerServerFrame {
    return {
      t: 'peer-state',
      activeInstanceId: this.activeInstanceId,
      manifest: this.manifest,
      instances: this.instances,
      lastRejection: this.rejection,
    }
  }

  private broadcastState() {
    if (!this.peers.size) return
    const frame = this.state()
    this.peers.forEach(peer => this.sendPeer(peer, frame))
  }

  /** Anything a harness would want to re-list on: tell ours, and every peer's. */
  private changed() {
    this.broadcastState()
    this.options.onToolsChanged()
  }

  private sendPeer(socket: WebSocket, frame: PeerServerFrame) {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  // MARK: Helpers
  // ============================================================================

  private settle(id: string, result: unknown, error: string | null) {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (error) call.reject(new Error(error))
    else call.resolve(result)
  }

  private pingAll() {
    this.list.forEach(connection => this.send(connection.socket, { t: 'ping' }))
    // Peers answer ws-level pings on their own; this only keeps idle sockets from being reaped
    this.peers.forEach(peer => peer.readyState === peer.OPEN && peer.ping())
  }

  private send(socket: WebSocket, frame: ServerFrame) {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(frame))
  }
}

/** The one message both the log and the agent get when the two halves disagree on the wire format. */
const protocolSkew = (theirs: unknown, extensionVersion: string | undefined) => {
  const version = extensionVersion ? ` (INSSIST ${extensionVersion})` : ''
  const fix =
    typeof theirs === 'number' && theirs < PROTOCOL_VERSION
      ? 'Update the INSSIST extension (chrome://extensions → Update), then turn AI Agents off and on.'
      : `Update this server: run \`npx ${PACKAGE_NAME}@latest\`, or clear the npx cache and restart the harness.`
  return `INSSIST extension${version} speaks bridge protocol v${String(theirs)}, this server speaks v${PROTOCOL_VERSION}. ${fix}`
}

/**
 * Compares two pairing tokens without leaking their relationship through timing. Length is
 * compared first because `timingSafeEqual` throws on unequal-length buffers; a length
 * mismatch is already a mismatch, so returning early there leaks nothing useful.
 */
const tokensEqual = (a: string, b: string) => {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
