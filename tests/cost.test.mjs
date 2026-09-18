/**
 * Cost arithmetic from the reviewed design's price table. These tests pin the
 * arithmetic and the assumption flags; they are not a claim about a real bill.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RATES, estimateCosts } from '../src/core/pricing.mjs'

/** OSS bills decimal GB, matching the design's price table. */
const GB = 1_000_000_000

test('the design table scenario lands near the reviewed annual estimate', () => {
  const result = estimateCosts({
    storedBytes: 40 * GB,
    objectCount: 10000,
    uploadedBytes: 2 * GB,
    uploadedObjects: 15000,
    fullDownloadsPerYear: 2,
    fullDownloadBytes: 40 * GB,
    sporadicObjects: 3000,
    sporadicBytes: 6 * GB,
    egressWindow: 'busy',
  })
  // Design section 7.2: whole-library downloads twice (80 GB) plus 6 GB of
  // partial retrievals = 86 GB of egress: storage 15.84, egress 43.00,
  // retrieval 6.19, about 65 CNY in total.
  assert.equal(result.perYear.storage, 15.84)
  assert.equal(result.perYear.egress, 43)
  assert.equal(result.perYear.restoreRetrieval, 6.19)
  assert.ok(result.totalPerYear > 64 && result.totalPerYear < 68, `total ${result.totalPerYear}`)
})

test('idle-window downloads are billed at half the busy rate', () => {
  const busy = estimateCosts({ storedBytes: 40 * GB, objectCount: 10000, egressWindow: 'busy' })
  const idle = estimateCosts({ storedBytes: 40 * GB, objectCount: 10000, egressWindow: 'idle' })
  assert.equal(idle.perYear.egress, busy.perYear.egress / 2)
})

test('sub-64KiB objects are billed at the minimum size', () => {
  const result = estimateCosts({ storedBytes: 1024, objectCount: 100, uploadedBytes: 1024, uploadedObjects: 100, fullDownloadsPerYear: 0, sporadicObjects: 0 })
  assert.equal(result.inputs.billableBytes, 100 * DEFAULT_RATES.minBillableObjectBytes)
  // 6.5536 MB at 0.033 CNY/GB/month for a year: a real but tiny cost that
  // two-decimal rounding would have reported as exactly zero.
  assert.equal(result.perYear.storage, 0.002595)
  assert.ok(result.perYear.storage > 0, 'a non-zero cost must never round to 0')
  assert.equal(result.perYear.egress, 0)
})

test('a zero-object remote costs nothing and reports its assumptions', () => {
  const result = estimateCosts({ storedBytes: 0, objectCount: 0, uploadedBytes: 0, uploadedObjects: 0, fullDownloadsPerYear: 0, sporadicDownloadsPerYear: 0 })
  assert.equal(result.totalPerYear, 0)
  assert.equal(result.pricingVersion, '2026-09 (design table)')
  assert.match(result.assumptions.note, /64 KiB/)
})
