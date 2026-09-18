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
  out += `  status     ${result.record?.status}\n\n`
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
    for (const failure of source.failed) out += `  ! ${source.id}/${failure.relPath} (${failure.action}): ${failure.error}\n`
    for (const skipped of source.skippedLocal.slice(0, 5)) out += `  ~ ${source.id}/${skipped.path}: ${skipped.reason}\n`
  }
  return out
}

export function verifyReport(result) {
  let out = `vault-sync verify: ${result.ok ? 'OK' : 'MISMATCH'} (${result.checked} files checked)\n\n`
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

export function statusReport(result) {
  let out = 'vault-sync status\n'
  out += `  engine   ${result.engine?.kind} (${result.engine?.detail})\n`
  out += `  state    ${result.stateDir}\n\n`
  out += table(result.sources, [
    { header: 'source', value: row => row.id },
    { header: 'indexed', value: row => row.indexed },
    { header: 'indexed-bytes', value: row => row.indexedBytesHuman },
    { header: 'remote-objects', value: row => row.remoteObjects },
    { header: 'last-index', value: row => row.lastIndexedAt ?? '' },
  ])
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
