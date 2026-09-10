import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR_NAME, HOME_ENV, PAIRINGS_FILE_NAME } from './constants.js'

/**
 * The server half of the automatic pairing: one small JSON file holding this server's stable
 * identity plus one token per browser profile.
 *
 * `serverId` must survive restarts, otherwise every `npx @inssist/mcp` would look like a
 * brand new server to the extension and mint a fresh token each time. Tokens are keyed by the
 * extension's per-profile instance id, so several Chrome profiles pair independently
 * against the same server.
 *
 * The file is written 0600 in a 0700 directory. That is the whole threat model: it defends
 * against other user accounts on the box, not against malware already running as the user,
 * which owns the browser anyway.
 */

type PairingFile = {
  version: number
  serverId: string
  tokens: Record<string, string>
}

export class PairingStore {
  private readonly path: string
  private readonly dir: string
  private data: PairingFile

  constructor() {
    this.dir = process.env[HOME_ENV] || join(homedir(), HOME_DIR_NAME)
    this.path = join(this.dir, PAIRINGS_FILE_NAME)
    this.data = this.read()
  }

  get serverId() {
    return this.data.serverId
  }

  get filePath() {
    return this.path
  }

  getToken(instanceId: string) {
    if (!instanceId) return null
    return this.data.tokens[instanceId] ?? null
  }

  setToken(instanceId: string, token: string) {
    if (!instanceId) throw new Error('setToken: instanceId is required')
    if (!token) throw new Error('setToken: token is required')
    this.data.tokens[instanceId] = token
    this.write()
  }

  /**
   * A corrupt or unreadable file is replaced rather than fatal: the only cost is a silent
   * re-pair on the next hello, and refusing to start would be a worse trade.
   */
  private read(): PairingFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<PairingFile>
      if (typeof parsed?.serverId === 'string' && parsed.serverId) {
        return {
          version: 1,
          serverId: parsed.serverId,
          tokens: this.readTokens(parsed.tokens),
        }
      }
    } catch {
      // Missing or damaged, fall through to a fresh identity
    }

    const fresh: PairingFile = { version: 1, serverId: randomUUID(), tokens: {} }
    this.data = fresh
    this.write()
    return fresh
  }

  private readTokens(tokens: unknown): Record<string, string> {
    if (!tokens || typeof tokens !== 'object') return {}
    return Object.fromEntries(
      Object.entries(tokens as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }

  private write() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  }
}
