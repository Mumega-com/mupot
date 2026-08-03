import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  readWorkloadIdentityToken,
  runGroundedQuery,
} from './vertex.mjs'

const ACCESS_TOKEN = 'ya29.test-access-token-that-must-never-be-returned'

function groundedResponse(overrides = {}) {
  return {
    candidates: [{
      content: {
        parts: [{ text: 'Viamar is mentioned after Example Shipping.' }],
      },
      groundingMetadata: {
        webSearchQueries: ['best international movers Toronto'],
        groundingChunks: [{
          web: {
            title: 'Example Shipping',
            domain: 'example.com',
            uri: 'https://example.com/international-moving',
          },
        }],
      },
    }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 200,
      totalTokenCount: 300,
    },
    ...overrides,
  }
}

test('gets an ephemeral Workload Identity token with the metadata header', async () => {
  let request
  const token = await readWorkloadIdentityToken({
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({
        access_token: ACCESS_TOKEN,
        expires_in: 3599,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(token, ACCESS_TOKEN)
  assert.equal(
    request.url,
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
  )
  assert.equal(request.init.headers['Metadata-Flavor'], 'Google')
  assert.equal(request.init.redirect, 'manual')
})

test('prefers an absolute GEO_VERTEX_ACCESS_TOKEN_FILE token over metadata auth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mupot-geo-vertex-'))
  const tokenPath = join(dir, 'vertex-token')
  await writeFile(tokenPath, `${ACCESS_TOKEN}\n`)
  const previous = process.env.GEO_VERTEX_ACCESS_TOKEN_FILE
  process.env.GEO_VERTEX_ACCESS_TOKEN_FILE = tokenPath

  try {
    let called = false
    const token = await readWorkloadIdentityToken({
      fetchImpl: async () => {
        called = true
        return new Response('{}')
      },
    })
    assert.equal(token, ACCESS_TOKEN)
    assert.equal(called, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.GEO_VERTEX_ACCESS_TOKEN_FILE
    else process.env.GEO_VERTEX_ACCESS_TOKEN_FILE = previous
  }
})

test('sends one explicit grounded Vertex request and normalizes its evidence', async () => {
  let request
  const result = await runGroundedQuery({
    accessToken: ACCESS_TOKEN,
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    prompt: 'Which companies are best for international moving from Toronto?',
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify(groundedResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.equal(
    request.url,
    'https://aiplatform.googleapis.com/v1/projects/mumegaproject/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
  )
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.deepEqual(JSON.parse(request.init.body), {
    contents: [{
      role: 'user',
      parts: [{ text: 'Which companies are best for international moving from Toronto?' }],
    }],
    tools: [{ googleSearch: {} }],
  })
  assert.deepEqual(result, {
    status: 'ok',
    answerText: 'Viamar is mentioned after Example Shipping.',
    webSearchQueries: ['best international movers Toronto'],
    citations: [{
      title: 'Example Shipping',
      domain: 'example.com',
      uri: 'https://example.com/international-moving',
    }],
    usage: {
      promptTokens: 100,
      candidateTokens: 200,
      totalTokens: 300,
    },
  })
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false)
})

test('derives a citation domain from its public URI when Vertex omits domain', async () => {
  const response = groundedResponse()
  delete response.candidates[0].groundingMetadata.groundingChunks[0].web.domain
  const result = await runGroundedQuery({
    accessToken: ACCESS_TOKEN,
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    prompt: 'Who is visible?',
  }, {
    fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
  })
  assert.equal(result.citations[0].domain, 'example.com')
})

test('returns honest empty state when the model provides no answer', async () => {
  const result = await runGroundedQuery({
    accessToken: ACCESS_TOKEN,
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    prompt: 'Who is visible?',
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [] }, groundingMetadata: {} }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 0, totalTokenCount: 11 },
    }), { status: 200 }),
  })

  assert.deepEqual(result, {
    status: 'empty',
    reason: 'empty_answer',
    answerText: '',
    webSearchQueries: [],
    citations: [],
    usage: { promptTokens: 11, candidateTokens: 0, totalTokens: 11 },
  })
})

test('maps redirect, HTTP, malformed, oversized, and timeout failures to stable body-free reasons', async () => {
  const base = {
    accessToken: ACCESS_TOKEN,
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    prompt: 'Who is visible?',
  }
  const cases = [
    {
      fetchImpl: async () => new Response('redirect secret detail', {
        status: 302,
        headers: { location: 'https://evil.example' },
      }),
      reason: 'vertex_redirect',
    },
    {
      fetchImpl: async () => new Response('upstream private detail', { status: 403 }),
      reason: 'vertex_http_403',
    },
    {
      fetchImpl: async () => new Response('{not-json', { status: 200 }),
      reason: 'vertex_invalid_response',
    },
    {
      fetchImpl: async () => new Response('x'.repeat(129), { status: 200 }),
      maxResponseBytes: 128,
      reason: 'vertex_response_too_large',
    },
    {
      fetchImpl: async () => {
        const error = new Error('socket included private detail')
        error.name = 'AbortError'
        throw error
      },
      reason: 'vertex_timeout',
    },
  ]

  for (const entry of cases) {
    const result = await runGroundedQuery(base, entry)
    assert.deepEqual(result, {
      status: 'failed',
      reason: entry.reason,
      answerText: '',
      webSearchQueries: [],
      citations: [],
      usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
    })
    assert.equal(JSON.stringify(result).includes('private detail'), false)
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false)
  }
})

test('bounds normalized answer, queries, citations, and usage without inventing values', async () => {
  const response = groundedResponse({
    candidates: [{
      content: { parts: [{ text: 'a'.repeat(20_000) }] },
      groundingMetadata: {
        webSearchQueries: Array.from({ length: 15 }, (_, index) => `query-${index}-${'q'.repeat(600)}`),
        groundingChunks: Array.from({ length: 25 }, (_, index) => ({
          web: {
            title: `title-${index}-${'t'.repeat(600)}`,
            uri: `https://source-${index}.example/${'u'.repeat(2200)}`,
          },
        })),
      },
    }],
    usageMetadata: {
      promptTokenCount: -1,
      candidatesTokenCount: '200',
      totalTokenCount: 999,
    },
  })
  const result = await runGroundedQuery({
    accessToken: ACCESS_TOKEN,
    googleProjectId: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    prompt: 'Who is visible?',
  }, {
    fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
  })

  assert.equal(result.answerText.length, 16_000)
  assert.equal(result.webSearchQueries.length, 10)
  assert.ok(result.webSearchQueries.every((value) => value.length <= 512))
  assert.equal(result.citations.length, 20)
  assert.ok(result.citations.every((value) =>
    value.title.length <= 512 && value.domain.length <= 253 && value.uri.length <= 2048))
  assert.deepEqual(result.usage, { promptTokens: 0, candidateTokens: 0, totalTokens: 999 })
})

test('rejects ambient model/location drift before making a request', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response('{}')
  }
  for (const mutation of [
    { location: 'us-central1' },
    { model: 'gemini-flash-latest' },
    { accessToken: '' },
  ]) {
    await assert.rejects(runGroundedQuery({
      accessToken: ACCESS_TOKEN,
      googleProjectId: 'mumegaproject',
      location: 'global',
      model: 'gemini-2.5-flash',
      prompt: 'Who is visible?',
      ...mutation,
    }, { fetchImpl }))
  }
  assert.equal(calls, 0)
})
