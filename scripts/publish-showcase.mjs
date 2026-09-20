#!/usr/bin/env node
/**
 * Publish the reviewed community showcase once, then read it back.
 *
 * Defaults to a preflight that changes nothing; posting needs --publish, because
 * a discussion is public the moment it is created and cannot be unpublished
 * quietly. The preflight checks the discussion-category rules, refuses to post
 * while the screenshots are not publicly fetchable at the exact local bytes, and
 * refuses a second project discussion for this account.
 *
 *   node scripts/publish-showcase.mjs            # preflight only
 *   node scripts/publish-showcase.mjs --publish  # create the discussion
 *   node scripts/publish-showcase.mjs --update   # replace the body of the
 *     discussion recorded in docs/community/discussion.json (for a correction)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const ALLOWED = new Set(['--publish', '--update'])
const options = new Set(process.argv.slice(2))
for (const option of options) if (!ALLOWED.has(option)) throw new Error(`unknown option ${option}`)

const config = JSON.parse(await readFile('docs/community/showcase.json', 'utf8'))
const body = await readFile(config.bodyFile, 'utf8')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const graphql = (query, variables = {}) => {
  const raw = execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  const parsed = JSON.parse(raw)
  if (parsed.errors) throw new Error(`GraphQL: ${JSON.stringify(parsed.errors)}`)
  return parsed.data
}

const fail = message => { throw new Error(message) }
const checks = []
const check = (label, ok, detail) => { checks.push({ label, ok, detail }); if (!ok) fail(`${label}: ${detail}`) }

// --- preflight -------------------------------------------------------------

check('title format', /^DSH \| .+ \| .+/.test(config.title), `must be "DSH | Name | one-line purpose", got ${JSON.stringify(config.title)}`)
check('unofficial label', body.includes('非官方项目'), 'the body must state this is an unofficial project')
check('project URL', body.includes('https://github.com/Mappedinfo/dsh-vault-sync'), 'the body must carry the project URL')
check('screenshots referenced', config.images.length > 0 && config.images.every(image => body.includes(image.split('/').pop())),
  'every configured image must be referenced by the body')

const viewer = graphql('query { viewer { login } }').viewer.login
check('authenticated', Boolean(viewer), 'gh is not authenticated')

const meta = graphql(`query($id:ID!) { node(id:$id) { ... on Repository { id nameWithOwner }
  } }`, { id: config.repositoryId })
check('repository id resolves', meta.node?.nameWithOwner === config.repository, `resolved ${meta.node?.nameWithOwner}`)

const category = graphql(`query($id:ID!) { node(id:$id) { ... on DiscussionCategory { id name } } }`, { id: config.categoryId })
check('category id resolves', Boolean(category.node?.name), 'category not found')

// A duplicate project post is removed by the category rules, so refuse early.
const search = graphql(`query($q:String!) { search(query:$q, type:DISCUSSION, first:50) {
  discussionCount nodes { ... on Discussion { id title url } } } }`,
  { q: `repo:${config.repository} author:${viewer} "Vault Sync" in:title` }).search
check('duplicate check bounded', search.discussionCount <= 50, `search returned ${search.discussionCount} results`)
const duplicates = search.nodes.filter(node => node.title?.startsWith('DSH | Vault Sync |'))
if (options.has('--update')) {
  // Replacing the recorded post is the point; anything else is a surprise.
  check('update targets the recorded post', duplicates.length === 1, `expected exactly one existing post, found ${duplicates.length}`)
} else {
  check('no existing post', duplicates.length === 0, `already posted: ${duplicates.map(d => d.url).join(', ')}`)
}

// The discussion renders images from GitHub, so they must be public at exactly
// the bytes reviewed here; a mismatch means the post would show something else.
for (const path of config.images) {
  const remote = JSON.parse(execFileSync('gh', ['api', `repos/Mappedinfo/dsh-vault-sync/contents/${path}?ref=main`], { encoding: 'utf8' }))
  const local = await readFile(path)
  check(`image public: ${path}`, remote.encoding === 'base64' && sha256(Buffer.from(remote.content, 'base64')) === sha256(local),
    'the committed image differs from, or is not visible as, the reviewed bytes')
}

for (const entry of checks) process.stdout.write(`  ok   ${entry.label}\n`)
process.stdout.write(`\npreflight: OK (${checks.length} checks, author ${viewer})\n`)
process.stdout.write(`title: ${config.title}\n`)
process.stdout.write(`body:  ${config.bodyFile} (${body.length} bytes, ${config.images.length} screenshots)\n`)

if (options.has('--update')) {
  const receipt = JSON.parse(await readFile('docs/community/discussion.json', 'utf8'))
  check('receipt author is this account', receipt.author === viewer, `receipt belongs to ${receipt.author}`)
  const updated = graphql(`mutation($input:UpdateDiscussionInput!) {
    updateDiscussion(input:$input) { discussion { id url number } } }`,
    { input: { discussionId: receipt.discussion.id, body } }).updateDiscussion.discussion
  process.stdout.write(`\nupdated: ${updated.url}\n`)
  const readBackUpdated = graphql(`query($id:ID!) { node(id:$id) { ... on Discussion { title url body } } }`, { id: updated.id }).node
  check('body replaced', readBackUpdated.body.trim() === body.trim(), 'the published body does not match the reviewed file')
  await writeFile('docs/community/discussion.json', `${JSON.stringify({
    ...receipt,
    bodySha256: sha256(Buffer.from(body)),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  process.stdout.write('receipt updated\n')
  process.exit(0)
}

if (!options.has('--publish')) {
  process.stdout.write('\nDry run. Re-run with --publish to create the discussion, or --update to correct it.\n')
  process.exit(0)
}

// --- publish ---------------------------------------------------------------

const created = graphql(`mutation($input:CreateDiscussionInput!) {
  createDiscussion(input:$input) { discussion { id url number } } }`,
  { input: { repositoryId: config.repositoryId, categoryId: config.categoryId, title: config.title, body } })
const discussion = created.createDiscussion.discussion
process.stdout.write(`\ncreated: ${discussion.url}\n`)

// Read it back rather than trusting the mutation's echo.
const readBack = graphql(`query($id:ID!) { node(id:$id) { ... on Discussion {
  id title url category { id name } } } }`, { id: discussion.id }).node
check('title read back', readBack.title === config.title, `read back ${readBack.title}`)
check('category read back', readBack.category.id === config.categoryId, `read back ${readBack.category.name}`)

await writeFile('docs/community/discussion.json', `${JSON.stringify({
  author: viewer,
  discussion: { id: discussion.id, number: discussion.number, url: discussion.url },
  title: readBack.title,
  category: readBack.category.name,
  bodySha256: sha256(Buffer.from(body)),
  images: config.images,
  publishedAt: new Date().toISOString(),
}, null, 2)}\n`)
process.stdout.write('receipt written to docs/community/discussion.json\n')
