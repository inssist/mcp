import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAssetParams, takesAssets } from '../dist/assets.js'

const dir = mkdtempSync(join(tmpdir(), 'inssist-assets-'))
const jpg = join(dir, 'a.jpg')
writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))

test('takesAssets keys on the assets param', () => {
  assert.equal(takesAssets({ params: [{ name: 'assets' }] }), true)
  assert.equal(takesAssets({ params: [{ name: 'caption' }] }), false)
})

test('local paths become inline bytes, urls pass through, other params untouched', async () => {
  const out = await resolveAssetParams({ assets: [jpg, 'https://x.test/b.png'], caption: 'hi' })
  assert.equal(out.caption, 'hi')
  assert.deepEqual(out.assets[0], { name: 'a.jpg', mime: 'image/jpeg', base64: '/9j/4A==' })
  assert.deepEqual(out.assets[1], { url: 'https://x.test/b.png' })
})

test('rejects unsupported types, schemes and missing files', async () => {
  await assert.rejects(resolveAssetParams({ assets: [join(dir, 'a.gif')] }), /Unsupported asset type/)
  await assert.rejects(resolveAssetParams({ assets: ['ftp://x/a.jpg'] }), /only local file paths/)
  await assert.rejects(resolveAssetParams({ assets: [join(dir, 'nope.jpg')] }), /not found/)
  await assert.rejects(resolveAssetParams({ assets: [42] }), /local file path or an http/)
})

test('no assets means no change', async () => {
  const params = { caption: 'x' }
  assert.equal(await resolveAssetParams(params), params)
})
