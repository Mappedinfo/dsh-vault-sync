/** Shared remote-backend contract, path safety and key layout. */

export class BackendError extends Error {
  constructor(message, { operation, key, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'BackendError'
    this.operation = operation
    this.key = key
    this.retryable = retryable
  }
}

/** Reject absolute keys, traversal and NUL before any I/O happens. */
export function assertSafeKey(key, { label = 'key' } = {}) {
  if (typeof key !== 'string' || key.length === 0) throw new BackendError(`${label} must be a non-empty string`, { operation: 'validate' })
  if (key.length > 1024) throw new BackendError(`${label} is too long (${key.length} > 1024)`, { operation: 'validate' })
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) throw new BackendError(`${label} must be relative (got ${key})`, { operation: 'validate' })
  if (key.includes('\\')) throw new BackendError(`${label} must use forward slashes (got ${key})`, { operation: 'validate' })
  if (key.includes('\u0000')) throw new BackendError(`${label} contains NUL`, { operation: 'validate' })
  for (const segment of key.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new BackendError(`${label} has an unsafe segment (${key})`, { operation: 'validate' })
  }
  return key
}

/**
 * Key layout inside a remote:
 *   <currentPrefix>/<remoteName>/<relPath>               live mirror
 *   <versionsPrefix>/<YYYY-MM-DD>/<remoteName>/<relPath> replaced or deleted versions
 *   <tempPrefix>/<runId>/<remoteName>/<relPath>          in-flight uploads, never current
 */
export function createLayout(remote) {
  const { currentPrefix, versionsPrefix, tempPrefix } = remote
  return {
    currentKey: (remoteName, relPath) => assertSafeKey([currentPrefix, remoteName, relPath].join('/')),
    currentPrefix: remoteName => [currentPrefix, remoteName].filter(Boolean).join('/'),
    currentRoot: currentPrefix,
    versionKey: (stamp, remoteName, relPath) => assertSafeKey([versionsPrefix, stamp, remoteName, relPath].join('/')),
    versionPrefix: (stamp, remoteName) => [versionsPrefix, stamp, remoteName].filter(Boolean).join('/'),
    versionsRoot: versionsPrefix,
    tempKey: (runId, remoteName, relPath) => assertSafeKey([tempPrefix, runId, remoteName, relPath].join('/')),
    tempPrefix: (runId, remoteName) => [tempPrefix, runId, remoteName].filter(Boolean).join('/'),
    tempRoot: tempPrefix,
  }
}

/**
 * Backend interface implemented by every transport:
 *   list(prefix) -> [{ key, size, mtimeMs?, digest?, etag? }]
 *   head(key) -> { key, size, mtimeMs?, digest? } | undefined
 *   putFile(key, localPath, { size, digest }) -> { key, size, digest }
 *   copy(fromKey, toKey) -> void
 *   remove(key) -> void
 *   describe() -> { kind, detail, capabilities }
 */
export function assertBackend(backend) {
  for (const method of ['list', 'head', 'putFile', 'copy', 'remove', 'describe']) {
    if (typeof backend?.[method] !== 'function') throw new BackendError(`backend is missing ${method}()`, { operation: 'validate' })
  }
  return backend
}
