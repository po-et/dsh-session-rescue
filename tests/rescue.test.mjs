import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyRepair, decodeSegment, diagnose, encodeArtifact, exportTranscript, planRepair, reconstructHeader,
} from '../lib/index.js'

const HEADER = JSON.stringify({ type: 'session', version: 0, id: 'session-test-0001', createdAt: 1755400000000, cwd: '/tmp/proj', delegationDepth: 0 })

let now = 1755400000000
const ev = (seq, type, extra = {}) => JSON.stringify({ seq, time: now += 500, type, ...extra })

/** A healthy 10-event log: one full turn with streamed text packed as a chunk row. */
function healthyLines() {
  return [
    ev(0, 'turn/start', { turn: 0 }),
    ev(1, 'user/message', { content: 'hello dsh, please fix my bug' }),
    ev(2, 'step/start', { turn: 0, step: 0 }),
    JSON.stringify({ type: 'text-chunks', seq0: 3, time0: now += 500, data: { index: 0, dt: [10, 10], texts: ['I will ', 'look at ', 'the code.'] } }),
    ev(6, 'assistant/message', { turn: 0, step: 0, message: { content: 'I will look at the code.' } }),
    ev(7, 'tool/call', { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
    ev(8, 'step/end', { turn: 0, step: 0 }),
    ev(9, 'turn/end', { turn: 0, reason: 'completed' }),
  ]
}

function writeTemp(name, buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'rescue-test-'))
  const path = join(dir, name)
  writeFileSync(path, buffer)
  return path
}

test('healthy zstd log scans as ok with correct event count', () => {
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, healthyLines()))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'ok')
  assert.equal(d.loadableEvents, 10)
  assert.equal(d.header.id, 'session-test-0001')
})

test('healthy plaintext log scans as ok', () => {
  const text = [HEADER, ...healthyLines()].join('\n') + '\n'
  const path = writeTemp('session.jsonl', Buffer.from(text))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'ok')
  assert.equal(d.loadableEvents, 10)
})

test('torn final zstd frame is benign (dsh self-heals)', () => {
  const full = encodeArtifact(HEADER, healthyLines())
  const torn = full.subarray(0, full.length - 7)
  const path = writeTemp('session.jsonl.zstd', torn)
  const d = diagnose(path, readFileSync(path))
  assert.notEqual(d.status, 'corrupt')
  assert.ok(d.issues.some(i => i.kind === 'torn-tail' && !i.fatalForDsh))
})

test('byte-identical replayed rows are dropped as duplicates and repair verifies', () => {
  const lines = healthyLines()
  const replayed = [...lines, lines[6], lines[7]] // rows for seq 7 and 8 appear again
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, replayed))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'corrupt')
  assert.ok(d.issues.some(i => i.kind === 'seq-overlap'))

  const plan = planRepair(d)
  assert.equal(plan.validated, true)
  assert.equal(plan.drops.length, 2)
  assert.ok(plan.drops.every(drop => drop.reason === 'duplicate-replay'))
  assert.equal(plan.resultEvents, 10)
  assert.equal(plan.lostEvents, 0)

  applyRepair(path, plan)
  const after = diagnose(path, readFileSync(path))
  assert.equal(after.status, 'ok')
  assert.equal(after.loadableEvents, 10)
})

test('synthetic closer block loses to the real continuation (community zero-loss fix)', () => {
  const lines = healthyLines().slice(0, 6) // rows covering seqs 0..7, turn still open
  const closers = [
    ev(8, 'step/end', { turn: 0, step: 0 }),
    ev(9, 'turn/end', { turn: 0, reason: 'interrupted' }),
    ev(10, 'session/end-seed', {}),
  ]
  const realContinuation = [
    ev(8, 'tool/result', { turn: 0, step: 0, callId: 'c1', result: 'file1 file2' }),
    ev(9, 'step/end', { turn: 0, step: 0 }),
    ev(10, 'turn/end', { turn: 0, reason: 'completed' }),
  ]
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, [...lines, ...closers, ...realContinuation]))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'corrupt')

  const plan = planRepair(d)
  assert.equal(plan.validated, true)
  assert.equal(plan.drops.filter(x => x.reason === 'synthetic-closer-block').length, 3)
  assert.equal(plan.resultEvents, 11)
  assert.equal(plan.lostEvents, 0)

  applyRepair(path, plan)
  const after = diagnose(path, readFileSync(path))
  assert.equal(after.status, 'ok')
  assert.equal(after.loadableEvents, 11)
  assert.ok(after.rows.some(r => r.raw.includes('"reason":"completed"')))
})

test('a real seq hole refuses repair unless --truncate, then verifies', () => {
  const lines = healthyLines()
  const withHole = [...lines.slice(0, 5), ...lines.slice(6)] // drop the row for seq 7
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, withHole))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'corrupt')
  assert.ok(d.issues.some(i => i.kind === 'seq-hole'))

  const refused = planRepair(d)
  assert.equal(refused.validated, false)
  assert.match(refused.validationErrors.join(' '), /--truncate/)

  const truncated = planRepair(d, { allowTruncate: true })
  assert.equal(truncated.validated, true)
  assert.equal(truncated.resultEvents, 7)

  applyRepair(path, truncated)
  assert.equal(diagnose(path, readFileSync(path)).status, 'ok')
})

test('unreadable header is reconstructed and the repair verifies', () => {
  const text = ['{broken header###', ...healthyLines()].join('\n') + '\n'
  const path = writeTemp('session.jsonl', Buffer.from(text))
  const d = diagnose(path, readFileSync(path))
  assert.equal(d.status, 'unreadable')

  const plan = planRepair(d, { reconstructedHeader: reconstructHeader('session-test-0001', 1755400000000) })
  assert.equal(plan.validated, true)
  applyRepair(path, plan)
  const after = diagnose(path, readFileSync(path))
  assert.equal(after.status, 'ok')
  assert.equal(after.header.id, 'session-test-0001')
})

test('a plan that would leave dangling sourceEventSeqs is refused', () => {
  const lines = [
    ...healthyLines(),
    ev(10, 'request/header', { header: {}, reason: 'x', sourceEventSeqs: [3, 99] }),
  ]
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, lines))
  const d = diagnose(path, readFileSync(path))
  const plan = planRepair(d)
  assert.equal(plan.validated, false)
  assert.match(plan.validationErrors.join(' '), /sourceEventSeq 99/)
})

test('export salvages text straight past corruption', () => {
  const lines = healthyLines()
  const corrupted = [...lines.slice(0, 6), 'garbage-not-json', ...lines.slice(7)]
  const path = writeTemp('session.jsonl.zstd', encodeArtifact(HEADER, corrupted))
  const d = diagnose(path, readFileSync(path))
  const md = exportTranscript(d)
  assert.match(md, /hello dsh, please fix my bug/)
  assert.match(md, /I will look at the code\./)
  assert.match(md, /🔧 `bash`/)
})

test('decodeSegment reverses dsh path escaping', () => {
  assert.equal(decodeSegment('session-abc'), 'session-abc')
  assert.equal(decodeSegment('a~002Fb~4E2D'), 'a/b中')
})
