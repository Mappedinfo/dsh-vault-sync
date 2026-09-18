/**
 * dsh-vault-sync host plugin: one insert mounts the vault_sync_* tools.
 * The plugin is independent of the Paper Library plugin: it reads ordinary
 * directories, treats a managed paper library as one source among several, and
 * never writes to any source.
 */
import { registerVaultSyncTools } from './tools.mjs'
import { bundledVaultSyncSkill, registerBundledSkills } from './skills.mjs'
import { defaultConfigCandidates, normalizeCliConfig } from './cli-runner.mjs'
import { configTemplate, normalizeConfig } from '../core/config.mjs'

export { bundledVaultSyncSkill }

export const name = 'vault-sync'
export const inject = ['tools']

export function resolveConfig(rawConfig = {}) {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('vault-sync: config must be an object')
  }
  for (const key of Object.keys(rawConfig)) {
    if (!['configPath', 'requireToolApproval'].includes(key)) throw new Error(`vault-sync: unknown config key ${key}`)
  }
  if (rawConfig.requireToolApproval !== undefined && typeof rawConfig.requireToolApproval !== 'boolean') {
    throw new Error('vault-sync: requireToolApproval must be boolean')
  }
  return {
    configPath: rawConfig.configPath ? normalizeCliConfig(rawConfig.configPath) : undefined,
    requireToolApproval: rawConfig.requireToolApproval ?? true,
  }
}

export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  // Loaded inside apply so the pure config surface stays importable without the
  // Harness runtime present (used by the standalone validation script).
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.effect(
    () => registerVaultSyncTools(ctx, defineTool, config),
    'vault-sync: tools',
  )
  // The skill is optional: a profile without the skills service still gets tools.
  ctx.inject?.(['skills'], scoped => {
    scoped.effect(() => registerBundledSkills(scoped), 'vault-sync: bundled skill')
  })
}

/** Diagnostics for `vault-sync doctor`-style questions asked from the host. */
export function describeConfiguration(rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  return { ...config, candidates: defaultConfigCandidates() }
}

export { configTemplate, normalizeConfig }
