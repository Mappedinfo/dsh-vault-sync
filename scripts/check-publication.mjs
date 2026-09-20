#!/usr/bin/env node
/**
 * Refuse to publish personal or secret material.
 *
 * A shipped template named the real bucket, which turns a public repository into
 * a target list: an OSS bucket name is globally unique and resolvable, so it
 * points at where the data lives. This check runs before a push and fails on the
 * classes of problem that are embarrassing or dangerous rather than merely
 * untidy.
 *
 *   node scripts/check-publication.mjs            # tracked files only
 *   node scripts/check-publication.mjs --history   # also every commit
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TRACKED = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)

/**
 * The private names this check refuses to publish, assembled at runtime.
 * Writing them literally would put them back in the very file that is supposed
 * to keep them out, and they would show up in a plain grep of the repository.
 */
function privateNamePattern() {
  const names = [
    ['paper', 'backup'].join('-'),
    ['shiqi', 'vault', 'obsidian'].join('-'),
    ['zotero', 'attanger'].join('-'),
  ]
  return new RegExp('\\b(' + names.join('|') + ')\\b')
}


const RULES = [
  { name: 'cloud access key id', pattern: /\b(LTAI[0-9A-Za-z]{8,}|AKIA[0-9A-Z]{12,}|STS[0-9A-Za-z]{12,})\b/, allow: /ABCDEFGH|EXAMPLE|dummy|test/i },
  { name: 'secret assignment', pattern: /(secret|password|token|access[_-]?key)[a-z_]*\s*[:=]\s*['"][^'"\s]{16,}['"]/i, allow: /EXAMPLE|dummy|test|placeholder/i },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'absolute home path', pattern: /\/Users\/[a-z0-9._-]+\// },
  // Assembled from parts so this file does not itself name the private
  // collections it is meant to catch.
  { name: 'private collection or vault name', pattern: privateNamePattern() },
  { name: 'real oss region', pattern: /oss-cn-(beijing|shanghai|shenzhen|zhangjiakou)/i },
]

/** Paths that are expected to carry local paths or examples. */
const EXEMPT = [/^scripts\/check-publication\.mjs$/, /^docs\/validation\.md$/]

function scanText(text, { file, where }) {
  const findings = []
  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (!match) continue
    if (rule.allow && rule.allow.test(match[0])) continue
    const line = text.slice(0, match.index).split('\n').length
    findings.push({ file, where, rule: rule.name, sample: match[0].slice(0, 60), line })
  }
  return findings
}

function main() {
  const withHistory = process.argv.includes('--history')
  const findings = []
  let skipped = 0

  for (const file of TRACKED) {
    if (EXEMPT.some(pattern => pattern.test(file))) { skipped += 1; continue }
    findings.push(...scanText(readFileSync(file, 'utf8'), { file, where: 'working tree' }))
  }

  if (withHistory) {
    // One pass per blob rather than per commit, so a long history stays cheap.
    // Only blobs carry file content; rev-list --objects also lists commits and
    // trees, which cat-file would reject.
    const listing = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'], { encoding: 'utf8' })
    const objects = listing.trim().split('\n').filter(Boolean)
      .filter(line => line.endsWith(' blob'))
      .map(line => line.split(' ')[0])
    for (const oid of objects) {
      let text
      try { text = execFileSync('git', ['cat-file', 'blob', oid], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) } catch { continue }
      const hits = scanText(text, { file: `blob ${oid.slice(0, 10)}`, where: 'history' })
      findings.push(...hits)
    }
  }

  if (findings.length === 0) {
    process.stdout.write(`check-publication: OK (${TRACKED.length - skipped} tracked files${withHistory ? ' plus history' : ''}; ${skipped} exempt)\n`)
    return 0
  }
  process.stderr.write(`check-publication: ${findings.length} finding(s)\n`)
  for (const finding of findings) {
    process.stderr.write(`  [${finding.rule}] ${finding.file}:${finding.line} (${finding.where}) -> ${finding.sample}\n`)
  }
  process.stderr.write('\nFix the finding, or add a narrow exemption with a comment explaining why it is safe.\n')
  return 1
}

process.exitCode = main()
