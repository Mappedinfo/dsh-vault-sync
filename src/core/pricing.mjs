/**
 * Cost estimation from the plan figures. Rates are transcribed from the
 * reviewed design's Aliyun OSS price table (archived, timely retrieval) and are
 * configuration, not measurements: the tool reports the rate set it used and
 * never presents the result as a bill.
 */
export const PRICING_VERSION = '2026-09 (design table)'

export const DEFAULT_RATES = {
  archiveStoragePerGbMonth: 0.033,
  egressBusyPerGb: 0.5,
  egressIdlePerGb: 0.25,
  putPerMillion: 30,
  getPerMillion: 10,
  restorePerGb: 0.072,
  minBillableObjectBytes: 64 * 1024,
  archiveMinimumDays: 60,
}

/** OSS bills in decimal GB (10^9 bytes), not GiB. */
export const GB = 1_000_000_000

/**
 * @param {object} input
 * @param {number} input.storedBytes        bytes currently mirrored (after the run)
 * @param {number} input.objectCount
 * @param {number} input.uploadedBytes      bytes transferred this run
 * @param {number} input.uploadedObjects
 * @param {number} [input.fullDownloadsPerYear]   full-library retrievals per year
 * @param {number} [input.fullDownloadBytes]      egress per full retrieval (defaults to storedBytes)
 * @param {number} [input.sporadicBytes]          total egress of all partial retrievals per year
 * @param {number} [input.sporadicObjects]        number of partial retrievals per year (request fees only)
 * @param {'busy'|'idle'} [input.egressWindow]
 */
export function estimateCosts(input, rates = DEFAULT_RATES) {
  const {
    storedBytes = 0,
    objectCount = 0,
    uploadedBytes = 0,
    uploadedObjects = 0,
    fullDownloadsPerYear = 2,
    fullDownloadBytes = storedBytes,
    sporadicBytes = 0,
    sporadicObjects = 0,
    egressWindow = 'busy',
  } = input

  // Objects below 64 KiB are billed as 64 KiB by OSS.
  const billableBytes = Math.max(storedBytes, objectCount * rates.minBillableObjectBytes)
  const storagePerYear = (billableBytes / GB) * rates.archiveStoragePerGbMonth * 12

  const egressBytes = fullDownloadsPerYear * fullDownloadBytes + sporadicBytes
  const egressPerGb = egressWindow === 'idle' ? rates.egressIdlePerGb : rates.egressBusyPerGb
  const egressPerYear = (egressBytes / GB) * egressPerGb
  const restorePerYear = (egressBytes / GB) * rates.restorePerGb

  const putPerYear = (uploadedObjects / 1_000_000) * rates.putPerMillion
  const getPerYear = ((fullDownloadsPerYear * objectCount + sporadicObjects) / 1_000_000) * rates.getPerMillion
  const restoreRequestsPerYear = ((fullDownloadsPerYear * objectCount) / 1_000_000) * rates.getPerMillion

  return {
    pricingVersion: PRICING_VERSION,
    unit: 'decimal GB (10^9 bytes), CNY',
    rates,
    assumptions: {
      egressWindow,
      fullDownloadsPerYear,
      sporadicObjects,
      archiveMinimumDays: rates.archiveMinimumDays,
      note: 'Storage assumes every object reaches archived storage; a 60-day minimum applies and sub-64 KiB objects are billed as 64 KiB.',
    },
    inputs: {
      storedBytes,
      objectCount,
      billableBytes,
      uploadedBytes,
      uploadedObjects,
      egressBytes,
    },
    perYear: {
      storage: round(storagePerYear),
      egress: round(egressPerYear),
      restoreRetrieval: round(restorePerYear),
      putRequests: round(putPerYear),
      getRequests: round(getPerYear),
      restoreRequests: round(restoreRequestsPerYear),
    },
    totalPerYear: round(storagePerYear + egressPerYear + restorePerYear + putPerYear + getPerYear + restoreRequestsPerYear),
    currency: 'CNY',
  }
}

/**
 * Two decimals is right for a real bill, but it would hide the cost of a small
 * mirror entirely. Keep enough precision that a non-zero cost stays non-zero.
 */
function round(value) {
  if (!Number.isFinite(value)) return 0
  if (value === 0) return 0
  const decimals = Math.abs(value) < 0.01 ? 6 : 2
  return Math.round(value * 10 ** decimals) / 10 ** decimals
}
