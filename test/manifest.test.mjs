import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotate, loadBundledManifest, toMcpTool } from '../dist/manifest.js'

const entry = (extra = {}) => ({
  name: 'ig_fetch_profile',
  description: 'Fetch a profile.',
  params: [{ name: 'username', type: 'string', description: 'Handle.', required: true }],
  pro: false,
  risk: 'read',
  source: 'actor',
  ...extra,
})

test('paced tool gets instance + instant, required list kept', () => {
  const tool = toMcpTool(entry())
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['username', 'instance', 'instant'])
  assert.deepEqual(tool.inputSchema.required, ['username'])
  assert.equal(tool.description, 'Fetch a profile.')
})

test('local (unpaced) tool gets instance only; PRO is spelled out', () => {
  const tool = toMcpTool(entry({ name: 'draft_list', paced: false, pro: true, params: [] }))
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['instance'])
  assert.equal(tool.inputSchema.required, undefined)
  assert.match(tool.description, /Requires INSSIST PRO/)
})

test('account_info takes neither routing param', () => {
  const tool = toMcpTool(entry({ name: 'account_info', params: [] }))
  assert.deepEqual(tool.inputSchema.properties, {})
})

test('bundled snapshot is present and well formed', () => {
  const tools = loadBundledManifest()
  assert.ok(tools.length >= 50, `only ${tools.length} tools`)
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]+$/)
    assert.ok(tool.description.length > 0 && tool.description.length < 700, tool.name)
    assert.ok(Array.isArray(tool.params), tool.name)
  }
})

test('annotations follow risk, pacing and the destructive set', () => {
  assert.deepEqual(toMcpTool(entry()).annotations, {
    title: 'Instagram fetch profile',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  })
  assert.equal(toMcpTool(entry()).title, 'Instagram fetch profile')
  assert.deepEqual(annotate(entry({ name: 'dm_send', risk: 'write' })), {
    title: 'DM send',
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  })
  assert.deepEqual(annotate(entry({ name: 'draft_delete', risk: 'write', paced: false })), {
    title: 'Draft delete',
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  })
  assert.equal(annotate(entry({ name: 'account_info', params: [] })).openWorldHint, false)
})

test('every bundled destructive-looking tool is in the destructive set', () => {
  for (const tool of loadBundledManifest()) {
    const looksDestructive = /delete|remove|block|cancel/.test(tool.name)
    if (looksDestructive) assert.equal(annotate(tool).destructiveHint, true, tool.name)
    if (tool.risk === 'read') assert.equal(annotate(tool).destructiveHint, false, tool.name)
  }
})
