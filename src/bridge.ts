import { PACKAGE_NAME, PEER_RETRY_MS } from './constants.js'
import { BridgeHub } from './bridge-hub.js'
import { BridgePeer } from './bridge-peer.js'
import type { PairingStore } from './pairing-store.js'
import type { BridgeInstance, BridgeLink, BridgeManifestEntry } from './protocol.js'

/**
 * Picks and, when needed, switches the role this process plays.
 *
 *   port free   -> hub: owns the browsers, serves peers
 *   port taken  -> peer: relays to the hub
 *   hub gone    -> the peer tries the port; the winner becomes the new hub and the extension
 *                  reconnects to it on its own backoff, the others dial the new hub
 *
 * `index.ts` only ever sees this facade, so a role change is invisible to the MCP side except
 * for the `tools/list_changed` it already handles.
 */

export type BridgeOptions = {
  port: number
  version: string
  pairings: PairingStore
  onToolsChanged: () => void
  log: (message: string) => void
}

export class Bridge implements BridgeLink {
  private readonly options: BridgeOptions
  /** The role object behind the facade; read-only, for tests and diagnostics. */
  link: BridgeLink | null = null
  private closed = false

  constructor(options: BridgeOptions) {
    this.options = options
  }

  /** Rejects only when the port is taken by something that is not a hub, or cannot be bound at all. */
  async start() {
    await this.becomeHubOrPeer()
  }

  get role() {
    return this.link?.role ?? 'hub'
  }

  get activeInstanceId(): string | null {
    return this.link?.activeInstanceId ?? null
  }

  get manifest(): BridgeManifestEntry[] | null {
    return this.link?.manifest ?? null
  }

  get instances(): BridgeInstance[] {
    return this.link?.instances ?? []
  }

  get lastRejection(): string | null {
    return this.link?.lastRejection ?? null
  }

  get active() {
    return this.activeInstanceId !== null
  }

  call(tool: string, params: Record<string, unknown>, instanceId?: string, instant?: boolean) {
    if (!this.link) return Promise.reject(new Error('No paired INSSIST extension is connected'))
    return this.link.call(tool, params, instanceId, instant)
  }

  waitForActive(timeoutMs: number) {
    if (!this.link) return Promise.resolve(false)
    return this.link.waitForActive(timeoutMs)
  }

  close() {
    this.closed = true
    this.link?.close()
    this.link = null
  }

  // MARK: Roles
  // ============================================================================

  private async becomeHubOrPeer() {
    const hub = new BridgeHub({
      port: this.options.port,
      version: this.options.version,
      pairings: this.options.pairings,
      onToolsChanged: this.options.onToolsChanged,
      log: this.options.log,
    })

    try {
      await hub.start()
      this.link = hub
      this.options.log(`Bridge on 127.0.0.1:${hub.port} (hub)`)
      return
    } catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE') throw error
    }

    await this.becomePeer()
  }

  private async becomePeer() {
    const peer = new BridgePeer({
      port: this.options.port,
      version: this.options.version,
      onStateChanged: this.options.onToolsChanged,
      onLost: () => void this.onHubLost(),
      log: this.options.log,
    })
    await peer.start()
    this.link = peer
    this.options.log(`Joined the running ${PACKAGE_NAME} on 127.0.0.1:${this.options.port} as a peer`)
  }

  /**
   * The hub's harness closed. Race for the port; losing just means another peer got there
   * first and is the hub now, so dial again after a beat. Keep trying until this process is
   * itself shut down: a harness that stays open must not end up bridgeless.
   */
  private async onHubLost() {
    this.link = null
    while (!this.closed) {
      try {
        await this.becomeHubOrPeer()
        this.options.onToolsChanged()
        return
      } catch (error) {
        this.options.log(`Bridge re-attach failed (${(error as Error).message || String(error)}), retrying`)
        await new Promise(resolve => setTimeout(resolve, PEER_RETRY_MS))
      }
    }
  }
}
