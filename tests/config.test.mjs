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
