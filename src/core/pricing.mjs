/**
 * Cost estimation from the plan figures.
 *
 * Rates are transcribed from the reviewed design's price table and corrected
 * against the Aliyun OSS pricing page for China (Beijing) on 2026-09-18. Two
 * official details matter and were wrong in the first version of this module:
 *
 *   1. OSS bills in binary GB (1 GB = 2^30 bytes, i.e. GiB), not decimal GB.
 *   2. Standard (LRS) storage is free for the first 5 GB in every region shown
 *      on the pricing page, which dominates the cost of a small mirror.
 *
 * Rates are configuration, not measurements: the tool reports the rate set it
 * used and never presents the result as a bill.
 */
export const PRICING_VERSION = '2026-09-18 (Aliyun OSS pricing page, China/Beijing)'

/** OSS bills binary GB (2^30 bytes), which the page also calls GiB. */
export const GiB = 1024 * 1024 * 1024

export const DEFAULT_RATES = {
  /** Archive (LRS), USD 0.00405/GB-month, converted at 7.2 CNY/USD. */
  archiveStoragePerGbMonth: 0.029,
  /** Low-frequency (LRS), USD 0.00935/GB-month. */
  infrequentStoragePerGbMonth: 0.067,
  /** Standard (LRS), USD 0.0160/GB-month. */
  standardStoragePerGbMonth: 0.115,
  /** Standard (LRS) is free up to this much stored data, per region. */
  standardFreeBytes: 5 * GiB,
  egressBusyPerGb: 0.5,
  egressIdlePerGb: 0.25,
  putPerMillion: 30,
  getPerMillion: 10,
  restorePerGb: 0.072,
  minBillableObjectBytes: 64 * 1024,
  archiveMinimumDays: 60,
  infrequentMinimumDays: 30,
}

export const USD_TO_CNY = 7.2

/**
 * @param {object} input
 * @param {number} input.storedBytes        bytes currently mirrored (after the run)
 * @param {number} input.objectCount
 * @param {number} input.uploadedBytes      bytes transferred this run
 * @param {number} input.uploadedObjects
 * @param {'archive'|'standard'|'infrequent'} [input.storageClass]  where the mirror settles
 * @param {number} [input.standardBytes]    bytes that stay on standard storage
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
    storageClass = 'archive',
    standardBytes = 0,
    fullDownloadsPerYear = 2,
    fullDownloadBytes = storedBytes,
    sporadicBytes = 0,
    sporadicObjects = 0,
    egressWindow = 'busy',
  } = input

  // Archive, infrequent and cold classes bill a 64 KiB minimum per object;
  // standard bills the real size.
  const billableBytes = storageClass === 'standard'
    ? storedBytes
    : Math.max(storedBytes, objectCount * rates.minBillableObjectBytes)
  const ratePerGbMonth = storageClass === 'standard'
    ? rates.standardStoragePerGbMonth
    : storageClass === 'infrequent'
      ? rates.infrequentStoragePerGbMonth
      : rates.archiveStoragePerGbMonth

  // The free allowance applies to standard storage only, and only to the data
  // that actually stays standard.
  const freeAllowance = storageClass === 'standard'
    ? Math.min(rates.standardFreeBytes, billableBytes)
    : Math.min(standardBytes, rates.standardFreeBytes)
  const chargedBytes = Math.max(0, billableBytes - freeAllowance)
  const storagePerYear = (chargedBytes / GiB) * ratePerGbMonth * 12

  const egressBytes = fullDownloadsPerYear * fullDownloadBytes + sporadicBytes
  const egressPerGb = egressWindow === 'idle' ? rates.egressIdlePerGb : rates.egressBusyPerGb
  const egressPerYear = (egressBytes / GiB) * egressPerGb
  const restorePerYear = (egressBytes / GiB) * rates.restorePerGb

  const putPerYear = (uploadedObjects / 1_000_000) * rates.putPerMillion
  const getPerYear = ((fullDownloadsPerYear * objectCount + sporadicObjects) / 1_000_000) * rates.getPerMillion
  const restoreRequestsPerYear = ((fullDownloadsPerYear * objectCount) / 1_000_000) * rates.getPerMillion

  return {
    pricingVersion: PRICING_VERSION,
    currency: 'CNY',
    unit: 'binary GB (2^30 bytes, GiB)',
    rates,
    assumptions: {
      storageClass,
      egressWindow,
      fullDownloadsPerYear,
      sporadicObjects,
      freeStandardAllowanceBytes: rates.standardFreeBytes,
      archiveMinimumDays: rates.archiveMinimumDays,
      infrequentMinimumDays: rates.infrequentMinimumDays,
      note: 'Standard (LRS) storage is free up to 5 GiB per region. Archive and infrequent classes bill a 64 KiB minimum per object and have 60- and 30-day minimum storage durations, so keep the versions prefix on standard storage if it is deleted on a schedule.',
      usdToCny: USD_TO_CNY,
    },
    inputs: {
      storedBytes,
      objectCount,
      billableBytes,
      /** The nominal free allowance for this storage class (0 when none applies). */
      nominalFreeAllowanceBytes: storageClass === 'standard' ? rates.standardFreeBytes : 0,
      /** The part of that allowance actually used up by this mirror. */
      freeAllowanceBytes: freeAllowance,
      chargedBytes,
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
