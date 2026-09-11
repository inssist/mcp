#!/usr/bin/env node
/**
 * Builds the Claude Desktop extension bundle: `build/inssist-mcp-<version>.mcpb`.
 *
 * An .mcpb is a zip of a manifest plus the server with its dependencies. Claude Desktop installs
 * it with one click and runs it on its own bundled Node, so a Desktop user needs neither Node nor
 * a terminal nor the JSON config. The staging directory mirrors the published npm layout
 * (`dist/` next to `mcp-bridge-manifest.json`) because `dist/manifest.js` resolves the snapshot
 * relative to itself.
 *
 *   npm run mcpb            # after `npm run build`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const snapshot = JSON.parse(readFileSync(join(root, 'mcp-bridge-manifest.json'), 'utf-8'))
const staging = join(root, 'build', 'mcpb')
const output = join(root, 'build', `inssist-mcp-${pkg.version}.mcpb`)

if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('run `npm run build` first')

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
for (const file of ['dist', 'mcp-bridge-manifest.json', 'package.json', 'package-lock.json', 'LICENSE', 'icon.png']) {
  cpSync(join(root, file), join(staging, file), { recursive: true })
}
execSync('npm ci --omit=dev --ignore-scripts --silent', { cwd: staging, stdio: 'inherit' })

const manifest = {
  manifest_version: '0.3',
  name: 'inssist',
  display_name: 'INSSIST for Instagram',
  version: pkg.version,
  description: pkg.description,
  long_description:
    'Lets Claude work inside your own logged-in Instagram session through the INSSIST Chrome ' +
    'extension: read profiles, posts and DMs, publish and schedule posts, reels and stories with ' +
    'music, pull insights and audience reports, download media. Personal, creator and business ' +
    'accounts alike. Everything runs on your computer; no password or token is ever shared.\n\n' +
    'Setup: install INSSIST in Chrome, open instagram.com, click the INSSIST menu, choose ' +
    '**Connect to AI Agents** and turn the toggle on.',
  author: pkg.author,
  homepage: pkg.homepage,
  documentation: pkg.homepage,
  support: 'https://inssist.com/support',
  repository: { type: 'git', url: 'https://github.com/inssist/mcp' },
  license: pkg.license,
  keywords: pkg.keywords,
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: { INSSIST_MCP_PORT: '${user_config.port}' },
    },
  },
  user_config: {
    port: {
      type: 'number',
      title: 'Bridge port',
      description: 'Loopback port the INSSIST extension dials. Change only if 48231 is taken, and set the same value in the extension.',
      default: 48231,
      min: 1024,
      max: 65535,
      required: false,
    },
  },
  tools: snapshot.tools.map(tool => ({ name: tool.name, description: tool.description })),
  tools_generated: true,
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=22.0.0' },
  },
}
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

execSync(`npx --yes @anthropic-ai/mcpb validate manifest.json`, { cwd: staging, stdio: 'inherit' })
rmSync(output, { force: true })
execSync(`npx --yes @anthropic-ai/mcpb pack . "${output}"`, { cwd: staging, stdio: 'inherit' })
console.log(`\n${output}`)
