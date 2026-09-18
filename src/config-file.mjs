/** Config file I/O. The file itself never contains secrets. */
import { readFile } from 'node:fs/promises'
import { CONFIG_VERSION, configTemplate, defaultConfigPath, normalizeConfig } from './core/config.mjs'
import { pathExists, writeJsonAtomic } from './core/util.mjs'

export { CONFIG_VERSION, configTemplate, defaultConfigPath, normalizeConfig }

export async function readConfig(configPath = defaultConfigPath()) {
  if (!(await pathExists(configPath))) {
    const error = new Error(`no vault-sync config at ${configPath}; run: vault-sync init`)
    error.code = 'CONFIG_NOT_FOUND'
    throw error
  }
  let raw
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot parse ${configPath}: ${error.message}`)
  }
  return normalizeConfig(raw, { configPath })
}

export async function writeConfig(configPath, raw) {
  const normalized = normalizeConfig(raw, { configPath })
  await writeJsonAtomic(configPath, { ...raw, version: CONFIG_VERSION }, { mode: 0o600 })
  return normalized
}
