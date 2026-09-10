import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeHub } from '../dist/bridge-hub.js'

const hub = () =>
  new BridgeHub({
    port: 0,
    version: 'test',
    pairings: { serverId: 'srv', getToken: () => null, setToken: () => {} },
    onToolsChanged: () => {},
    log: () => {},
  })

test('waitForActive gives up after the timeout when nothing connects', async () => {
  const started = Date.now()
  assert.equal(await hub().waitForActive(60), false)
  assert.ok(Date.now() - started >= 55)
})

test('close wakes a pending waiter at once', async () => {
  const h = hub()
  const started = Date.now()
  const pending = h.waitForActive(5_000)
  h.close()
  await pending
  assert.ok(Date.now() - started < 1_000)
})

test('no active browser means no manifest and a null active', () => {
  const h = hub()
  assert.equal(h.active, null)
  assert.equal(h.manifest, null)
  assert.equal(h.lastRejection, null)
})
