/**
 * Cost arithmetic. These tests pin the arithmetic, the unit and the assumption
 * flags against the Aliyun OSS pricing page (China/Beijing, 2026-09-18); they
 * are not a claim about a real bill and not a capacity measurement.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RATES, GiB, estimateCosts } from '../src/core/pricing.mjs'

const designCase = (patch = {}) => estimateCosts({
  storedBytes: 40 * GiB,
  objectCount: 10000,
  uploadedBytes: 2 * GiB,
  uploadedObjects: 15000,
  storageClass: 'archive',
  fullDownloadsPerYear: 2,
  fullDownloadBytes: 40 * GiB,
  sporadicObjects: 3000,
  sporadicBytes: 6 * GiB,
  egressWindow: 'busy',
  ...patch,
})

test('the design scenario recalculates in binary GB against the 2026 price page', () => {
  const result = designCase()
  // The design's 15.84 storage figure assumed decimal GB and an older archive
  // rate; the recalculated value is recorded rather than papered over.
  assert.equal(result.perYear.storage, 13.92)
  assert.equal(result.perYear.egress, 43)
  assert.equal(result.perYear.restoreRetrieval, 6.19)
  assert.ok(result.totalPerYear > 63 && result.totalPerYear < 65, `total ${result.totalPerYear}`)
  assert.equal(result.unit, 'binary GB (2^30 bytes, GiB)')
})

test('standard storage inside the 5 GiB free allowance costs nothing', () => {
  const result = estimateCosts({ storedBytes: 4 * GiB, objectCount: 2000, storageClass: 'standard', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.equal(result.perYear.storage, 0)
  assert.equal(result.inputs.chargedBytes, 0)
  assert.equal(result.inputs.nominalFreeAllowanceBytes, 5 * GiB)
  assert.equal(result.inputs.freeAllowanceBytes, 4 * GiB, 'only the used part of the allowance is reported')
})

test('switching standard to infrequent inside the free allowance costs more, not less', () => {
  const standard = estimateCosts({ storedBytes: 4 * GiB, objectCount: 2000, storageClass: 'standard', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  const infrequent = estimateCosts({ storedBytes: 4 * GiB, objectCount: 2000, storageClass: 'infrequent', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.ok(infrequent.perYear.storage > standard.perYear.storage,
    'a discounted unit price cannot beat a free allowance')
})

test('per GiB the classes order standard > infrequent > archive', () => {
  const input = { storedBytes: 40 * GiB, objectCount: 10000, fullDownloadsPerYear: 0, sporadicObjects: 0 }
  const standard = estimateCosts({ ...input, storageClass: 'standard' }).perYear.storage
  const infrequent = estimateCosts({ ...input, storageClass: 'infrequent' }).perYear.storage
  const archive = estimateCosts({ ...input, storageClass: 'archive' }).perYear.storage
  assert.ok(standard > infrequent && infrequent > archive, `${standard} / ${infrequent} / ${archive}`)
})

test('idle-window downloads are billed at half the busy rate', () => {
  const busy = designCase({ egressWindow: 'busy' })
  const idle = designCase({ egressWindow: 'idle' })
  assert.equal(idle.perYear.egress, busy.perYear.egress / 2)
})

test('archive and infrequent bill a 64 KiB minimum per object; standard does not', () => {
  const archive = estimateCosts({ storedBytes: 1024, objectCount: 100, storageClass: 'archive', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  const standard = estimateCosts({ storedBytes: 1024, objectCount: 100, storageClass: 'standard', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.equal(archive.inputs.billableBytes, 100 * DEFAULT_RATES.minBillableObjectBytes)
  assert.equal(standard.inputs.billableBytes, 1024)
  assert.equal(standard.perYear.storage, 0, 'tiny standard data sits inside the free allowance')
  assert.ok(archive.perYear.storage > 0, 'a non-zero cost must never round to 0')
})

test('the minimum storage durations are reported so the versions prefix is not archived blindly', () => {
  const result = designCase()
  assert.equal(result.assumptions.archiveMinimumDays, 60)
  assert.equal(result.assumptions.infrequentMinimumDays, 30)
  assert.match(result.assumptions.note, /versions prefix/)
})

test('the unit string and currency are reported separately', () => {
  const result = estimateCosts({ storedBytes: 0, objectCount: 0, storageClass: 'standard', fullDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.equal(result.currency, 'CNY')
  assert.match(result.unit, /GiB/)
})

test('a zero-object remote costs nothing and reports its assumptions', () => {
  const result = estimateCosts({ storedBytes: 0, objectCount: 0, uploadedBytes: 0, uploadedObjects: 0, fullDownloadsPerYear: 0, sporadicDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.equal(result.totalPerYear, 0)
  assert.equal(result.pricingVersion, '2026-09-18 (Aliyun OSS pricing page, China/Beijing)')
  assert.match(result.assumptions.note, /64 KiB/)
})
