#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Throwaway MCP client for manual end-to-end checks: spawns the built server over stdio,
 * initializes, then polls `tools/list` and calls `account_info` on a timeline, so a human
 * has room to pair a browser in between. Before pairing the call answers with pairing
 * instructions; after pairing it returns the live logged-in account.
 *
 * Usage: node scripts/smoke.mjs [holdSeconds]
 */

const hold = Number.parseInt(process.argv[2] ?? '60', 10)
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })

let nextId = 1
const pending = new Map()
let buffer = ''

child.stdout.on('data', chunk => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const resolve = pending.get(message.id)
    if (!resolve) continue
    pending.delete(message.id)
    resolve(message)
  }
})

const request = (method, params = {}) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise(resolve => pending.set(id, resolve))
}

const notify = method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)

const stamp = (label, value) => console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'inssist-smoke', version: '1.0.0' },
})
stamp('initialize', init.result)
notify('notifications/initialized')

stamp('tools/list (before pairing)', (await request('tools/list')).result)
stamp(
  'tools/call account_info (before pairing)',
  (await request('tools/call', { name: 'account_info', arguments: {} })).result,
)

console.log(`\n--- holding ${hold}s, pair the browser now ---`)
for (let elapsed = 0; elapsed < hold; elapsed += 5) {
  await sleep(5000)
  console.log(`[t+${elapsed + 5}s] waiting`)
}

stamp('tools/list (after pairing)', (await request('tools/list')).result)
stamp(
  'tools/call account_info (after pairing)',
  (await request('tools/call', { name: 'account_info', arguments: {} })).result,
)

child.kill('SIGTERM')
process.exit(0)
