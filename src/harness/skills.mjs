/**
 * Bundled skill registration. The skill ships inside this package and is read
 * once at mount time; nothing is installed, fetched or watched.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAX_SKILL_BYTES = 16000

export function bundledSkill(name) {
  const directory = fileURLToPath(new URL(`../../skills/${name}/`, import.meta.url))
  const path = fileURLToPath(new URL(`../../skills/${name}/SKILL.md`, import.meta.url))
  const source = readFileSync(path, 'utf8')
  if (source.length > MAX_SKILL_BYTES) throw new Error(`Bundled skill ${name} exceeds its ${MAX_SKILL_BYTES}-byte budget`)
  const match = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ("[^\n]+")\r?\n---\r?\n([\s\S]+)$/.exec(source)
  if (!match) throw new Error(`Invalid bundled skill frontmatter in ${name}`)
  return {
    name: match[1],
    description: JSON.parse(match[2]),
    content: match[3].trim(),
    source: 'bundled',
    path,
    resourceBase: { kind: 'directory', path: directory },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

export function bundledVaultSyncSkill() {
  return bundledSkill('vault-sync')
}

export function registerBundledSkills(ctx) {
  const disposers = []
  try {
    disposers.push(ctx.skills.register(bundledVaultSyncSkill()))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose?.()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}
