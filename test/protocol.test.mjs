import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrame } from '../dist/protocol.js'

test('parseFrame accepts a tagged object', () => {
  assert.deepEqual(parseFrame('{"t":"pong"}'), { t: 'pong' })
})

test('parseFrame never throws on garbage', () => {
  assert.equal(parseFrame('not json'), null)
  assert.equal(parseFrame('42'), null)
  assert.equal(parseFrame('{"x":1}'), null)
  assert.equal(parseFrame('{"t":5}'), null)
})
