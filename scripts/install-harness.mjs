#!/usr/bin/env node
/**
 * Register this plugin with a local DeepSeek Harness profile through the
 * official CLI. Nothing global is modified, and no secret is read or written.
 *
 *   node scripts/install-harness.mjs --harness /path/to/deepseek-harness \
 *     --home /path/to/dsh-home --profile web [--dsh /path/to/dsh]
 */
import { spawn } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const options = { profile: 'web' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--harness') options.harness = argv[++i]
    else if (arg === '--home') options.home = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--dsh') options.dsh = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

async function run(command, args, env) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.on('error', rejectPromise)
    child.on('close', code => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} ${args.join(' ')} exited ${code}`))))
  })
}

const USAGE = `install vault-sync into a local DeepSeek Harness profile

Options
  --dsh <path>        dsh executable (default: resolve "dsh" on PATH)
  --harness <path>    DeepSeek Harness checkout (required unless --dsh is given)
  --home <path>       DSH home / profile configuration directory
  --profile <name>    profile to register with (default: web)
`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  for (const key of ['harness', 'home', 'dsh']) {
    if (options[key] !== undefined && !isAbsolute(options[key])) throw new Error(`--${key} must be an absolute path`)
  }
  const dsh = options.dsh ?? (options.harness ? join(options.harness, 'node_modules', '.bin', 'dsh') : 'dsh')
  if (!options.dsh) {
    try { await access(dsh) } catch { /* fall back to PATH lookup below */ }
  }
  const env = { ...process.env }
  if (options.home) env.DSH_HOME = options.home
  const pluginPath = await realpath(PLUGIN_ROOT)
  process.stdout.write(`registering ${pluginPath} into profile "${options.profile}"\n`)
  await run(dsh, ['plugin', '--profile', options.profile, 'add', pluginPath], env)
  process.stdout.write([
    '',
    'Done. Restart the Harness Web process and reload the browser tab.',
    'The vault_sync_* tools appear in the model tool list; no credentials were read or written.',
    `Config file: ${join(options.home ?? env.DSH_HOME ?? '<DSH_HOME>', 'vault-sync', 'config.json')}`,
    '',
  ].join('\n'))
}

main().catch(error => {
  process.stderr.write(`install-harness: ${error.message}\n`)
  process.exitCode = 1
})

export { parseArgs }
