import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { BRIDGE_HOST, CALL_TIMEOUT_MS, PEER_PATH, PROTOCOL_VERSION } from './constants.js'
import type { BridgeInstance, BridgeLink, BridgeManifestEntry, PeerClientFrame, PeerServerFrame } from './protocol.js'

/**
 * The other role a `@inssist/mcp` process can play: a relay to the hub that already owns the
 * port. A second Claude Code window, or Claude Desktop next to Cursor, each start their own
 * server process; without this they would fight over one port and all but the first would
 * have no browser. A peer mirrors the hub's state (which browsers, which tools) and forwards
 * every call, so every harness sees the same INSSIST.
 *
 * A peer is deliberately thin: no pairing file, no extension protocol, no manifest of its own.
 * When the hub goes away the socket closes, `onLost` fires, and `bridge.ts` decides whether
 * this process now takes the port or dials again.
 */

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type BridgePeerOptions = {
  port: number
  version: string
  onStateChanged: () => void
  onLost: () => void
  log: (message: string) => void
}

export class BridgePeer implements BridgeLink {
  readonly role = 'peer' as const
  private readonly options: BridgePeerOptions
  private readonly pending = new Map<string, PendingCall>()
  private readonly readyWaiters = new Set<() => void>()
  private socket: WebSocket | null = null
  private closed = false

  activeInstanceId: string | null = null
  manifest: BridgeManifestEntry[] | null = null
  instances: BridgeInstance[] = []
  lastRejection: string | null = null

  constructor(options: BridgePeerOptions) {
    this.options = options
  }

  /** Resolves once the hub has answered `peer-hello`; rejects if it cannot be reached at all. */
  async start() {
    const socket = new WebSocket(`ws://${BRIDGE_HOST}:${this.options.port}${PEER_PATH}`)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      socket.once('error', onError)
      socket.once('open', () => {
        socket.off('error', onError)
        this.send({ t: 'peer-hello', v: PROTOCOL_VERSION, version: this.options.version, pid: process.pid })
        resolve()
      })
    })

    socket.on('message', data => this.onFrame(String(data)))
    socket.on('error', error => this.options.log(`Peer socket error: ${String(error)}`))
    socket.on('close', () => this.onClose())
  }

  get active() {
    return this.activeInstanceId !== null
  }

  async call(tool: string, params: Record<string, unknown>, instanceId?: string, instant?: boolean) {
    if (!tool) throw new Error('call: tool name is required')
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('No paired INSSIST extension is connected')
    }

    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Tool "${tool}" timed out after ${Math.round(CALL_TIMEOUT_MS / 1000)}s`))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      this.send({ t: 'peer-call', id, tool, params, instanceId, instant })
    })
  }

  waitForActive(timeoutMs: number) {
    if (this.active) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const done = (ready: boolean) => {
        clearTimeout(timer)
        this.readyWaiters.delete(wake)
        resolve(ready)
      }
      const wake = () => done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      this.readyWaiters.add(wake)
    })
  }

  close() {
    this.closed = true
    this.failPending('Bridge is shutting down')
    this.readyWaiters.forEach(wake => wake())
    this.socket?.close()
    this.socket = null
  }

  // MARK: Frames
  // ============================================================================

  private onFrame(data: string) {
    let frame: PeerServerFrame
    try {
      frame = JSON.parse(data) as PeerServerFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return

    if (frame.t === 'peer-state') return this.onState(frame)
    if (frame.t === 'peer-result') return this.settle(frame.id, frame.result, null)
    if (frame.t === 'peer-error') return this.settle(frame.id, null, frame.message || 'Tool call failed')
  }

  private onState(frame: PeerServerFrame & { t: 'peer-state' }) {
    const wasActive = this.active
    this.activeInstanceId = frame.activeInstanceId ?? null
    this.manifest = Array.isArray(frame.manifest) ? frame.manifest : null
    this.instances = Array.isArray(frame.instances) ? frame.instances : []
    this.lastRejection = frame.lastRejection ?? null
    if (!wasActive && this.active) this.readyWaiters.forEach(wake => wake())
    this.options.onStateChanged()
  }

  private onClose() {
    this.socket = null
    this.activeInstanceId = null
    this.manifest = null
    this.instances = []
    this.failPending('The bridge hub went away; retry the call')
    if (this.closed) return
    this.options.log('Hub connection lost')
    this.options.onStateChanged()
    this.options.onLost()
  }

  private settle(id: string, result: unknown, error: string | null) {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (error) call.reject(new Error(error))
    else call.resolve(result)
  }

  private failPending(message: string) {
    this.pending.forEach(call => {
      clearTimeout(call.timer)
      call.reject(new Error(message))
    })
    this.pending.clear()
  }

  private send(frame: PeerClientFrame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(frame))
  }
}
