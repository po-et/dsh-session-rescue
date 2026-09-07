// Regression fixtures modeled on corruption shapes reported by dsh users, so the
// planner is checked against the field, not only against synthetic guesses.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyRepair, diagnose, encodeArtifact, planRepair } from '../lib/index.js'

const HEADER = JSON.stringify({ type: 'session', version: 0, id: 'session-field-01', createdAt: 1756382000000, cwd: '/tmp/proj', delegationDepth: 0 })
const row = (seq, time, type, extra = {}) => JSON.stringify({ seq, time, type, ...extra })
const tmp = (name, buf) => { const p = join(mkdtempSync(join(tmpdir(), 'field-')), name); writeFileSync(p, buf); return p }

/**
 * deepseek-harness#1497, @smallshieh 2026-08-28 (dsh-plugin-desktop 2.0.3,
 * persistence-jsonl 0.1.1-rc.2): an interrupted tool call got crash-repair
 * closers at seqs N..N+2 (all stamped with the interrupt time t0) plus a
 * session/end-seed at N+3 on reopen; the resumed turn then delivered the REAL
 * tool result and continued, re-allocating seqs from N. dsh's loader fails at
 * the next turn/end with "seq gap in committed region (expected N+4, got N)".
 * The user's validated fix: drop the four stale rows, keep the continuation.
 */
test('#1497 smallshieh shape 1: interrupt closers + end-seed collide with the resumed real result', () => {
  const N = 12293, t0 = 1756382100000
  const prefix = []
  for (let s = 0; s < N; s++) prefix.push(row(s, t0 - (N - s) * 100, s % 7 === 0 ? 'step/start' : 'assistant/chunk', { turn: 30, step: 33 }))
  // Batch A — interrupt-time closers, all sharing t0; end-seed written at reopen (t0+311s)
  const batchA = [
    row(N, t0, 'tool/result', { turn: 30, step: 33, callId: 'call_abc', isError: true, message: { id: `interrupted-tool-result-call_abc-${N}`, content: 'interrupted' } }),
    row(N + 1, t0, 'step/end', { turn: 30, step: 33 }),
    row(N + 2, t0, 'turn/end', { turn: 30, reason: 'interrupted' }),
    row(N + 3, t0 + 311_000, 'session/end-seed', {}),
  ]
  // Batch B — after reopen (~t0+410s), fresh per-row timestamps; the turn continues
  const tB = t0 + 410_000
  const batchB = [
    row(N, tB, 'tool/result', { turn: 30, step: 33, callId: 'call_abc', isError: false, message: { id: 'real-result', content: 'done: 42 rows' } }),
    row(N + 1, tB + 5, 'step/end', { turn: 30, step: 33 }),
    row(N + 2, tB + 10, 'step/start', { turn: 30, step: 34 }),
    row(N + 3, tB + 15, 'assistant/chunk', { turn: 30, step: 34, chunk: { type: 'text-delta', text: 'ok' } }),
  ]
  const tail = []
  for (let s = N + 4; s < N + 40; s++) tail.push(row(s, tB + 20 + s, s === N + 39 ? 'turn/end' : 'assistant/chunk', s === N + 39 ? { turn: 30, reason: 'completed' } : { turn: 30, step: 34 }))
  const path = tmp('session.jsonl.zstd', encodeArtifact(HEADER, [...prefix, ...batchA, ...batchB, ...tail]))

  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'corrupt')
  const gap = d.issues.find(i => i.kind === 'seq-overlap')
  assert.match(gap.detail, new RegExp(`expected ${N + 4}, got ${N}\\)`), 'reproduces the reported loader error')

  const plan = planRepair(d)
  assert.equal(plan.validated, true, plan.validationErrors.join('; '))
  const closerDrops = plan.drops.filter(x => x.reason === 'synthetic-closer-block')
  assert.equal(closerDrops.length, 4, 'drops exactly the four stale Batch A rows')
  assert.equal(plan.lostEvents, 0, 'no real content lost')
  assert.equal(plan.resultEvents, N + 40)

  applyRepair(path, plan)
  const after = diagnose(path, readFileSync(path))
  assert.equal(after.status, 'ok')
  assert.equal(after.loadableEvents, N + 40)
  const kept = after.rows.map(r => r.raw)
  assert.ok(kept.some(r => r.includes('"isError":false')), 'the REAL tool result survives')
  assert.ok(!kept.some(r => r.includes('interrupted-tool-result-')), 'the synthetic placeholder is gone')
  assert.ok(!kept.some(r => r.includes('"reason":"interrupted"')), 'the stale interrupted turn/end is gone')
  assert.ok(kept.some(r => r.includes('"reason":"completed"')), 'the turn now ends completed')
})

/**
 * deepseek-harness#1497, @smallshieh 2026-08-28, second instance: a turn was
 * interrupted right after step/start (no pending tool call), so the crash
 * closers are only step/end + turn/end{interrupted} + session/end-seed at
 * seqs N..N+2. The resume path then appended the ENTIRE remaining tail —
 * hundreds of rows, the same turn continuing and completing, then further
 * turns — starting again at seq N, without truncating the closers. The
 * user's validated fix: drop the three stale closers, keep the rewritten
 * tail. Packed chunk rows are used here because the JSONL backend packs
 * streamed deltas, so the first rewritten row may cover several seqs.
 */
test('#1497 smallshieh shape 2: full tail rewrite from a recycled seq, closers only, packed chunk rows', () => {
  const N = 5750, t0 = 1756400000000
  const prefix = []
  for (let s = 0; s < N; s++) prefix.push(row(s, t0 - (N - s) * 50, s % 9 === 0 ? 'step/start' : 'assistant/chunk', { turn: 5, step: 7 }))
  const closers = [
    row(N, t0, 'step/end', { turn: 5, step: 7 }),
    row(N + 1, t0, 'turn/end', { turn: 5, reason: 'interrupted' }),
    row(N + 2, t0 + 900, 'session/end-seed', {}),
  ]
  // Rewritten tail from N: a packed text-chunks row covering N..N+4, then the turn completes, then turn 6.
  const tB = t0 + 275_000
  const rewritten = [
    JSON.stringify({ type: 'text-chunks', seq0: N, time0: tB, data: { index: 0, dt: [10, 10, 10, 10], texts: ['con', 'tinu', 'ing ', 'the ', 'turn'] } }),
    row(N + 5, tB + 100, 'assistant/message', { turn: 5, step: 7, message: { content: 'continuing the turn' } }),
    row(N + 6, tB + 110, 'step/end', { turn: 5, step: 7 }),
    row(N + 7, tB + 120, 'turn/end', { turn: 5, reason: 'completed' }),
    row(N + 8, tB + 5000, 'turn/start', { turn: 6 }),
    row(N + 9, tB + 5010, 'user/message', { content: 'next question' }),
    row(N + 10, tB + 5020, 'step/start', { turn: 6, step: 0 }),
    JSON.stringify({ type: 'text-chunks', seq0: N + 11, time0: tB + 5030, data: { index: 0, dt: [5, 5], texts: ['an', 'sw', 'er'] } }),
    row(N + 14, tB + 5100, 'step/end', { turn: 6, step: 0 }),
    row(N + 15, tB + 5110, 'turn/end', { turn: 6, reason: 'completed' }),
  ]
  const path = tmp('session.jsonl.zstd', encodeArtifact(HEADER, [...prefix, ...closers, ...rewritten]))

  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'corrupt')
  assert.match(d.issues.find(i => i.kind === 'seq-overlap').detail, new RegExp(`expected ${N + 3}, got ${N}\\)`))

  const plan = planRepair(d)
  assert.equal(plan.validated, true, plan.validationErrors.join('; '))
  assert.equal(plan.drops.filter(x => x.reason === 'synthetic-closer-block').length, 3, 'drops exactly the three stale closers')
  assert.equal(plan.drops.length, 3, 'nothing else is dropped')
  assert.equal(plan.lostEvents, 0)
  assert.equal(plan.resultEvents, N + 16)

  applyRepair(path, plan)
  const after = diagnose(path, readFileSync(path))
  assert.equal(after.status, 'ok')
  assert.equal(after.loadableEvents, N + 16)
  const kept = after.rows.map(r => r.raw)
  assert.ok(!kept.some(r => r.includes('"reason":"interrupted"')), 'stale interrupted turn/end gone')
  assert.equal(kept.filter(r => r.includes('"reason":"completed"')).length, 2, 'both turns end completed')
  assert.ok(kept.some(r => r.includes('"content":"next question"')), 'later turns preserved')
})
