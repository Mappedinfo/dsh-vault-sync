import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { configTemplate, normalizeConfig } from '../src/core/config.mjs'
import { parseEnvFile } from '../src/core/credentials.mjs'
import { globToRegExp, pathAllowed, mapLimit, joinKey, formatBytes, redactDeep } from '../src/core/util.mjs'

test('config rejects secrets anywhere in the tree', () => {
  assert.throws(() => normalizeConfig({ ...configTemplate(), accessKeySecret: 'x' }), /not allowed in config/)
  assert.throws(() => normalizeConfig({ ...configTemplate(), remote: { type: 'oss', secretKey: 'x' } }), /not allowed in config/)
})

test('config requires absolute paths and unique ids', () => {
  assert.throws(() => normalizeConfig({ ...configTemplate(), sources: [{ id: 'a', root: 'relative/path' }] }), /absolute path/)
  const template = configTemplate()
  assert.throws(() => normalizeConfig({ ...template, sources: [template.sources[0], { ...template.sources[1], id: template.sources[0].id }] }), /unique/)
  assert.throws(() => normalizeConfig({ ...template, sources: [template.sources[0], { ...template.sources[1], remote: template.sources[0].remote }] }), /unique/)
})

test('config rejects bad remote values instead of silently accepting them', () => {
  const template = configTemplate()
  assert.throws(() => normalizeConfig({ ...template, remote: { type: 'nope' } }), /remote.type/)
  assert.throws(() => normalizeConfig({ ...template, remote: { type: 'oss', concurrency: 99 } }), /concurrency/)
  assert.throws(() => normalizeConfig({ ...template, remote: { type: 'oss', currentPrefix: 'same', versionsPrefix: 'same' } }), /distinct/)
  assert.throws(() => normalizeConfig({ ...template, remote: { type: 'filesystem' } }), /remote.root is required/)
})

test('env file parsing handles comments, quotes and invalid names', () => {
  const parsed = parseEnvFile([
    '# comment',
    'OSS_ACCESS_KEY_ID=abc',
    'OSS_ACCESS_KEY_SECRET="quoted value"',
    "OSS_REGION='cn-hangzhou'",
    'BAD NAME=x',
    'EMPTY=',
  ].join('\n'))
  assert.equal(parsed.OSS_ACCESS_KEY_ID, 'abc')
  assert.equal(parsed.OSS_ACCESS_KEY_SECRET, 'quoted value')
  assert.equal(parsed.OSS_REGION, 'cn-hangzhou')
  assert.equal(parsed['BAD NAME'], undefined)
  assert.equal(parsed.EMPTY, '')
})

test('globs, includes and excludes pick the intended files', () => {
  assert.ok(globToRegExp('backups/**').test('backups/a/b.pdf'))
  assert.ok(!globToRegExp('backups/**').test('current/backups/a.pdf'))
  assert.ok(globToRegExp('**/*.tmp').test('deep/nested/x.tmp'))
  assert.ok(!pathAllowed('backups/x.pdf', { exclude: ['backups/**'] }))
  assert.ok(pathAllowed('papers/a.pdf', { exclude: ['backups/**'] }))
  assert.ok(!pathAllowed('papers/a.pdf', { include: ['kg/**'] }))
  assert.ok(pathAllowed('.git/config', { exclude: ['.git/**'] }) === false)
})

test('bounded concurrency never overlaps more than the limit', async () => {
  let active = 0
  let peak = 0
  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async value => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return value * 2
  })
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14])
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`)
})

test('key joining never doubles separators or drops segments', () => {
  assert.equal(joinKey('current', 'papers', 'a.pdf'), 'current/papers/a.pdf')
  assert.equal(joinKey('/current/', '', 'papers/'), 'current/papers')
})

test('reports redact secret-shaped fields', () => {
  const redacted = redactDeep({ accessKeyId: 'LTAI5tABCDEFGH', nested: { secretAccessKey: 'verysecretvalue', ok: 'keep' } })
  assert.ok(!redacted.accessKeyId.includes('ABCDEFGH'))
  assert.ok(!redacted.nested.secretAccessKey.includes('secretvalue'))
  assert.equal(redacted.nested.ok, 'keep')
  assert.equal(formatBytes(1536), '1.5 KiB')
})

test('default config keeps secrets out and points at absolute paths', () => {
  const template = configTemplate({ stateDir: join('/', 'tmp', 'state') })
  const normalized = normalizeConfig(template)
  assert.equal(normalized.stateDir, join('/', 'tmp', 'state'))
  assert.ok(normalized.sources.every(source => source.root.startsWith('/')))
})

test('credentialsFile is optional but must be absolute, and is never a secret itself', () => {
  const template = configTemplate({ stateDir: '/tmp/state' })
  assert.equal(normalizeConfig(template).credentialsFile, undefined)
  assert.equal(normalizeConfig({ ...template, credentialsFile: '/tmp/vault-sync/oss.env' }).credentialsFile, '/tmp/vault-sync/oss.env')
  assert.throws(() => normalizeConfig({ ...template, credentialsFile: 'oss.env' }), /absolute path/)
  assert.throws(() => normalizeConfig({ ...template, credentialsFile: '/tmp/x', accessKeyId: 'LTAI' }), /not allowed in config/)
})

test('concurrent atomic writes to one path never collide on a temp file', async () => {
  // Regression: the temp name used to be pid+millisecond, so two writers in the
  // same millisecond fought over one temp file and the second rename failed.
  const { writeJsonAtomic, readJson, writeTextAtomic } = await import('../src/core/util.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'vault-atomic-'))
  try {
    const target = join(dir, 'shared.json')
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeJsonAtomic(target, { i })))
    const value = await readJson(target)
    assert.ok(value && Number.isInteger(value.i), 'the file must still hold one complete document')
    const text = join(dir, 'shared.txt')
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeTextAtomic(text, `line-${i}\n`)))
    const leftovers = (await (await import('node:fs/promises')).readdir(dir)).filter(name => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no temp files may be left behind')
    const names = (await (await import('node:fs/promises')).readdir(dir)).sort()
    assert.deepEqual(names, ['shared.json', 'shared.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
