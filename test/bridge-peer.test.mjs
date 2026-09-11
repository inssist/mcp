import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createServer } from 'node:net'
import { Bridge } from '../dist/bridge.js'

const pairings = { serverId: 'srv', getToken: () => null, setToken: () => {} }
const quiet = () => {}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check, ms = 2_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await wait(20)
  }
  return false
}

/** A stand-in for the extension: dials with a chrome-extension Origin, pairs, answers calls. */
const fakeExtension = (port, instanceId, onCall) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://fake' })
    socket.on('error', reject)
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', v: 1, instanceId, agent: { version: 't', build: null } })))
    socket.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.t === 'server-hello') socket.send(JSON.stringify({ t: 'pair', token: 'tok-0123456789abcdef' }))
      if (frame.t === 'ready') {
        socket.send(JSON.stringify({ t: 'manifest', tools: [{ name: 'echo', description: 'e', params: [], pro: false, risk: 'read', source: 'actor' }] }))
        resolve(socket)
      }
      if (frame.t === 'call') socket.send(JSON.stringify({ t: 'result', id: frame.id, result: onCall(frame) }))
      if (frame.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }))
    })
  })

const startBridge = async (port, version = '1') => {
  const changes = { count: 0 }
  const bridge = new Bridge({ port, version, pairings, log: quiet, onToolsChanged: () => changes.count++ })
  await bridge.start()
  return { bridge, changes }
}

test('second instance joins the first as a peer and relays calls through it', async () => {
  const { bridge: hub } = await startBridge(0)
  const port = hubPort(hub)
  const { bridge: peer, changes } = await startBridge(port)
  assert.equal(hub.role, 'hub')
  assert.equal(peer.role, 'peer')

  const extension = await fakeExtension(port, 'profile-a', frame => ({ echoed: frame.tool, params: frame.params }))
  assert.ok(await until(() => peer.activeInstanceId === 'profile-a'))
  assert.equal(peer.manifest?.[0]?.name, 'echo')
  assert.equal(peer.instances[0]?.ready, true)
  assert.ok(changes.count >= 1)

  const result = await peer.call('echo', { x: 1 })
  assert.deepEqual(result, { echoed: 'echo', params: { x: 1 } })

  extension.close()
  assert.ok(await until(() => peer.activeInstanceId === null))
  peer.close()
  hub.close()
})

test('a peer becomes the hub when the hub goes away', async () => {
  const { bridge: hub } = await startBridge(0)
  const port = hubPort(hub)
  const { bridge: peer } = await startBridge(port)
  assert.equal(peer.role, 'peer')

  hub.close()
  assert.ok(await until(() => peer.role === 'hub' && hubPort(peer) === port, 4_000))

  const extension = await fakeExtension(port, 'profile-b', () => 'ok')
  assert.ok(await until(() => peer.activeInstanceId === 'profile-b'))
  assert.equal(await peer.call('echo', {}), 'ok')

  extension.close()
  peer.close()
})

test('a web page cannot open the peer path', async () => {
  const { bridge: hub } = await startBridge(0)
  const port = hubPort(hub)
  const rejected = await new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/peer`, { origin: 'https://evil.example' })
    socket.on('error', () => resolve(true))
    socket.on('open', () => resolve(false))
  })
  assert.equal(rejected, true)
  hub.close()
})

const hubPort = bridge => bridge.link.port

test('start survives a hub that is still dying on the port', async () => {
  // A raw TCP listener that resets every connection stands in for a hub mid-shutdown: the bind
  // fails with EADDRINUSE and the peer dial with ECONNRESET. It goes away after a moment.
  const dying = createServer(socket => socket.destroy())
  await new Promise(resolve => dying.listen(0, '127.0.0.1', resolve))
  const port = dying.address().port
  setTimeout(() => dying.close(), 700)

  const started = Date.now()
  const { bridge } = await startBridge(port)
  assert.equal(bridge.role, 'hub')
  assert.ok(Date.now() - started >= 500, 'should have waited for the port')
  bridge.close()
})
