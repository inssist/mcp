import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const load = async dir => {
  process.env.INSSIST_MCP_HOME = dir
  const { PairingStore } = await import(`../dist/pairing-store.js?${Math.random()}`)
  return new PairingStore()
}

test('creates a 0600 pairing file with a stable serverId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inssist-mcp-'))
  const first = await load(dir)
  assert.match(first.serverId, /^[0-9a-f-]{36}$/)
  assert.equal(statSync(first.filePath).mode & 0o777, 0o600)

  first.setToken('profile-a', 'tok-aaaaaaaaaaaaaaaa')
  const second = await load(dir)
  assert.equal(second.serverId, first.serverId)
  assert.equal(second.getToken('profile-a'), 'tok-aaaaaaaaaaaaaaaa')
  assert.equal(second.getToken('missing'), null)
})

test('a corrupt file is replaced, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inssist-mcp-'))
  writeFileSync(join(dir, 'mcp-pairings.json'), '{broken')
  const store = await load(dir)
  assert.ok(store.serverId)
  assert.deepEqual(JSON.parse(readFileSync(store.filePath, 'utf-8')).tokens, {})
})
