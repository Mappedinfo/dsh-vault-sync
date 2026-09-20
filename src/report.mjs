/** Report formatting shared by the CLI and the Harness tools. */
import { formatBytes, redactDeep } from './core/util.mjs'

export function jsonReport(payload) {
  return `${JSON.stringify(redactDeep(payload), null, 2)}\n`
}

function table(rows, columns) {
  if (rows.length === 0) return '  (none)\n'
  const widths = columns.map(column => Math.max(column.header.length, ...rows.map(row => String(column.value(row) ?? '').length)))
  const line = values => `  ${values.map((value, index) => String(value ?? '').padEnd(widths[index])).join('  ').trimEnd()}\n`
  let out = line(columns.map(column => column.header))
  out += `  ${widths.map(width => '-'.repeat(width)).join('  ')}\n`
  for (const row of rows) out += line(columns.map(column => column.value(row)))
  return out
}

export function planReport(planResult) {
  let out = 'vault-sync plan\n'
  out += `  sources   ${planResult.summary.length}\n`
  out += `  to upload ${planResult.totals.upload} files (${formatBytes(planResult.totals.bytesUploaded)})\n`
  out += `  versions  ${planResult.totals.version}\n`
  out += `  deletes   ${planResult.totals.delete}\n`
  out += `  unchanged ${planResult.totals.unchanged}\n`
  if (planResult.tempKeys > 0) out += `  stale temp objects ${planResult.tempKeys}\n`
  out += '\n'
  out += table(planResult.summary, [
    { header: 'source', value: row => row.id },
    { header: 'local', value: row => row.scanned },
    { header: 'upload', value: row => row.upload },
    { header: 'version', value: row => row.version },
    { header: 'delete', value: row => row.delete },
    { header: 'unchanged', value: row => row.unchanged ?? 0 },
    { header: 'unverified', value: row => row.unchangedUnverified ?? 0 },
    { header: 'remote-only', value: row => row.remoteOnly ?? 0 },
    { header: 'skipped-local', value: row => row.skippedLocal ?? 0 },
    { header: 'bytes', value: row => formatBytes(row.bytesToUpload) },
  ])
  return out
}

export function runReport(result) {
  if (result.dryRun) return `(dry run)\n${planReport(result.plan)}`
  let out = `vault-sync run ${result.runId}\n`
  out += `  engine     ${result.engine?.kind ?? 'unknown'} (${result.engine?.detail ?? ''})\n`
  out += `  uploaded   ${result.totals.upload} files (${result.totals.bytesUploadedHuman})\n`
  out += `  versions   ${result.totals.version}\n`
  out += `  deletes    ${result.totals.delete}\n`
  out += `  failed     ${result.totals.failed}\n`
  out += `  temp-pruned ${(result.tempPruned ?? []).length}\n`
  out += `  status     ${result.record?.status}\n`
  if (result.totals.archiveWarnings) out += `  archive    ${result.totals.archiveWarnings} version(s) could not be archived (warned, not failed)\n`
  if (result.totals.pending) out += `  pending    ${result.totals.pending} source(s) never reached\n`
  if (result.progressPath && result.interrupted) out += `  progress   ${result.progressPath}\n`
  out += '\n'
  out += table(result.perSource, [
    { header: 'source', value: row => row.id },
    { header: 'scanned', value: row => row.scanned },
    { header: 'uploaded', value: row => row.uploaded },
    { header: 'versioned', value: row => row.versioned },
    { header: 'deleted', value: row => row.deleted },
    { header: 'unchanged', value: row => row.unchanged },
    { header: 'failed', value: row => row.failed.length },
    { header: 'skipped-local', value: row => row.skippedLocal.length },
  ])
  for (const source of result.perSource) {
    if (source.error) out += `  ! ${source.id}: source failed: ${source.error}\n`
    if (source.pending) out += `  - ${source.id}: not reached (run stopped)\n`
    for (const failure of source.failed) out += `  ! ${source.id}/${failure.relPath} (${failure.action}): ${failure.error}\n`
    for (const skipped of source.skippedLocal.slice(0, 5)) out += `  ~ ${source.id}/${skipped.path}: ${skipped.reason}\n`
  }
  return out
}

export function verifyReport(result) {
  const label = result.status === 'ok' ? 'OK' : result.status === 'okWithWarnings' ? 'OK WITH WARNINGS' : 'MISMATCH'
  let out = `vault-sync verify: ${label} (${result.checked} files checked)\n`
  if (result.warnings) {
    const parts = []
    if (result.warnings.unreadableFiles) parts.push(`${result.warnings.unreadableFiles} unreadable`)
    if (result.warnings.unverifiedFiles) parts.push(`${result.warnings.unverifiedFiles} not digest-verified`)
    if (result.warnings.sampled) parts.push('sampled')
    if (result.warnings.remoteOnlyTruncated) parts.push('remote-only list truncated at 50')
    if (parts.length) out += `  warnings: ${parts.join(', ')}\n`
  }
  out += '\n'
  out += table(result.sources, [
    { header: 'source', value: row => row.id },
    { header: 'local', value: row => row.local },
    { header: 'remote', value: row => row.remoteTotal },
    { header: 'checked', value: row => row.checked },
    { header: 'missing', value: row => row.missing.length },
    { header: 'size', value: row => row.sizeMismatch.length },
    { header: 'digest', value: row => row.digestMismatch.length },
    { header: 'unverified', value: row => row.digestUnavailable },
    { header: 'remote-only', value: row => row.remoteOnlyCount },
  ])
  for (const source of result.sources) {
    for (const path of source.missing.slice(0, 5)) out += `  ! ${source.id}: no remote copy of ${path}\n`
    for (const item of source.sizeMismatch.slice(0, 5)) out += `  ! ${source.id}: size mismatch ${item.relPath} local=${item.local} remote=${item.remote}\n`
    for (const item of source.digestMismatch.slice(0, 5)) out += `  ! ${source.id}: digest mismatch ${item.relPath}\n`
  }
  return out
}

export function progressReport(rows) {
  if (rows.length === 0) return 'vault-sync progress: no run in progress (no progress files)\n'
  let out = 'vault-sync progress\n'
  for (const row of rows) {
    const totals = row.totals ?? {}
    const percent = totals.planned > 0 ? ((totals.done / totals.planned) * 100).toFixed(1) : 'unknown'
    out += `  ${row.runId}  ${row.status}${row.stale ? ' (stale: no live run lock)' : ''}\n`
    out += `    ${totals.done ?? 0}/${totals.planned ?? 0} files (${percent}%)  ${totals.bytesHuman ?? ''}`
    if (row.ratePerSec) out += `  ${row.ratePerSec} files/s`
    if (row.etaSeconds) out += `  ETA ${Math.round(row.etaSeconds / 60)}m`
    out += '\n'
    out += `    failed ${totals.failed ?? 0} | started ${row.startedAt} | updated ${row.updatedAt ?? '-'}\n`
    for (const source of row.sources ?? []) {
      out += `      ${source.id}: ${source.done}/${source.scanned}`
      if (source.failed) out += ` (${source.failed} failed)`
      if (source.currentFile) out += `  current ${source.currentFile}`
      out += '\n'
    }
  }
  return out
}

export function recoverReport(result, { dryRun = false } = {}) {
  if (dryRun) {
    let out = `vault-sync recover (dry run) → ${result.target}\n`
    out += `  to download ${result.totals.download} files (${formatBytes(result.totals.bytes)}), ${result.totals.skip} already present, ${result.totals.remote} on the remote\n\n`
    out += table(result.sources, [
      { header: 'source', value: row => row.id },
      { header: 'remote', value: row => row.remote },
      { header: 'remote-objects', value: row => row.remote },
      { header: 'download', value: row => row.download },
      { header: 'present', value: row => row.skip },
      { header: 'bytes', value: row => formatBytes(row.bytes) },
    ])
    if (result.unsafe.length > 0) {
      out += '\n  refused (would not be written):\n'
      for (const entry of result.unsafe.slice(0, 20)) out += `  ! ${entry.id}: ${entry.key} (${entry.reason})\n`
    }
    return out
  }
  let out = `vault-sync recover → ${result.target}\n`
  out += `  downloaded ${result.totals.downloaded}/${result.totals.planned} files (${result.totals.bytesHuman})\n`
  out += `  already present ${result.totals.skipped}\n`
  if (result.totals.archived) out += `  archived, needs thawing ${result.totals.archived}\n`
  if (result.totals.corrupt) out += `  corrupt ${result.totals.corrupt}\n`
  out += `  failed ${result.totals.failed}\n`
  if (result.totals.stopped) out += '  stopped early on request; re-run to continue\n'
  out += `  result ${result.ok ? 'complete' : 'INCOMPLETE'}\n\n`
  out += table(result.sources, [
    { header: 'source', value: row => row.id },
    { header: 'planned', value: row => row.planned },
    { header: 'downloaded', value: row => row.downloaded },
    { header: 'present', value: row => row.skipped },
    { header: 'archived', value: row => row.archived },
    { header: 'corrupt', value: row => row.corrupt },
    { header: 'failed', value: row => row.failed },
    { header: 'bytes', value: row => formatBytes(row.bytes) },
  ])
  if (result.totals.archived) {
    out += '\n  An archived object cannot be read until OSS thaws it. Thaw it, then re-run:\n'
    out += '    ossutil restore oss://<bucket>/<key>\n'
  }
  return out
}

export function statusReport(result) {
  let out = 'vault-sync status\n'
  out += `  engine   ${result.engine?.kind} (${result.engine?.detail})\n`
  out += `  state    ${result.stateDir}\n`
  out += `  scope    ${result.remoteListed ? 'local index plus remote listing' : 'local index only (no remote call)'}\n\n`
  out += table(result.sources, [
    { header: 'source', value: row => row.id },
    { header: 'indexed', value: row => row.indexed },
    { header: 'indexed-bytes', value: row => row.indexedBytesHuman },
    ...(result.remoteListed ? [{ header: 'remote-objects', value: row => row.remoteObjects ?? 0 }] : []),
    { header: 'last-index', value: row => row.lastIndexedAt ?? '' },
  ])
  if ((result.progress ?? []).length > 0) {
    out += '\n  in progress\n'
    out += table(result.progress, [
      { header: 'run', value: row => row.runId },
      { header: 'status', value: row => `${row.status}${row.stale ? ' (stale)' : ''}` },
      { header: 'files', value: row => `${row.totals?.done ?? 0}/${row.totals?.planned ?? 0}` },
      { header: 'failed', value: row => row.totals?.failed ?? 0 },
      { header: 'rate', value: row => (row.ratePerSec ? `${row.ratePerSec}/s` : '') },
      { header: 'current', value: row => row.sources?.find(s => s.currentFile)?.currentFile ?? '' },
    ])
  }
  if (result.runs.length > 0) {
    out += '\n  recent runs\n'
    out += table(result.runs, [
      { header: 'run', value: row => row.runId },
      { header: 'status', value: row => row.status },
      { header: 'started', value: row => row.startedAt },
      { header: 'upload', value: row => row.totals?.upload ?? '' },
      { header: 'failed', value: row => row.totals?.failed ?? '' },
    ])
  }
  return out
}
