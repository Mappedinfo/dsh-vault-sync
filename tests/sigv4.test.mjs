/**
 * SigV4 signing pinned against AWS-published vectors from the aws4 test suite
 * (boto/botocore tests/unit/auth/aws4_testsuite). These are exact-signature
 * comparisons: a wrong canonical request or header set fails here rather than
 * silently failing authentication against OSS in production.
 *
 * The first version of this implementation unconditionally signed an
 * x-amz-content-sha256 header, which produced 726c5c48... instead of the
 * published 5fa00fa3... for get-vanilla; the vectors caught it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalQueryString, encodeKey, signRequest } from '../src/backends/s3.mjs'

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  now: new Date('2015-08-30T12:36:00Z'),
}

test('get-vanilla: GET / with only host and x-amz-date signed', () => {
  const signed = signRequest({ method: 'GET', path: '/', headers: { host: 'example.amazonaws.com' }, ...CREDENTIALS })
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  )
})

test('the canonical URI is used verbatim, never normalized', () => {
  const signed = signRequest({ method: 'GET', path: '/./', headers: { host: 'example.amazonaws.com' }, ...CREDENTIALS })
  assert.equal(signed.canonicalRequest.split('\n')[1], '/./')
})

test('header value whitespace is normalized but never case-folded', () => {
  const signed = signRequest({
    method: 'GET',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'my-header': '  Value   With   Spaces  ' },
    ...CREDENTIALS,
  })
  assert.match(signed.canonicalRequest, /my-header:Value With Spaces/)
  assert.match(signed.authorization, /my-header/)
})

test('payload hash appears in the canonical request without being signed', () => {
  const hash = 'a'.repeat(64)
  const signed = signRequest({ method: 'PUT', path: '/key', headers: { host: 'h' }, payloadHash: hash, ...CREDENTIALS })
  assert.ok(signed.canonicalRequest.endsWith(hash))
  assert.ok(!signed.authorization.includes('x-amz-content-sha256'))
})

test('a session token joins the signed headers automatically', () => {
  const signed = signRequest({ method: 'GET', path: '/', headers: { host: 'h' }, sessionToken: 'tok', ...CREDENTIALS })
  assert.match(signed.authorization, /x-amz-security-token/)
  assert.equal(signed.headers['x-amz-security-token'], 'tok')
})

test('canonical query sorting is byte-ordered and encodes values', () => {
  assert.equal(canonicalQueryString({ 'list-type': '2', prefix: 'a b/c', 'max-keys': 10 }), 'list-type=2&max-keys=10&prefix=a%20b%2Fc')
})

test('object keys keep separators and encode reserved characters', () => {
  assert.equal(encodeKey('current/papers/2024/a b.pdf'), 'current/papers/2024/a%20b.pdf')
  assert.equal(encodeKey('current/笔记/graph.json'), `current/${encodeURIComponent('笔记')}/graph.json`)
  assert.equal(encodeKey('current/a+b&c=d.pdf'), 'current/a%2Bb%26c%3Dd.pdf')
})
