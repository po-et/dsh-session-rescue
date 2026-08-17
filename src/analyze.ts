/**
 * Overlap resolution and repair planning.
 *
 * The dominant dsh corruption family (community postmortems #420, #1497,
 * #2627, #2649) is REPLAY: after a crash, interrupt, or a second process
 * touching the same session, already-committed seqs get written again —
 * either as byte-identical duplicates or as a synthetic "closer" block
 * (`step/end` + `turn/end{interrupted}` + …) colliding with the real
 * continuation. Content is usually NOT lost, so the right repair is to drop
 * the redundant side and keep everything else — never blind truncation.
 *
 * Safety posture (community postmortem #2257: a naive repair produced
 * dangling sourceEventSeqs and killed a 500k-event session permanently):
 * every plan is re-validated for contiguity and reference integrity before
 * anything is written; an invalid plan is refused, not "fixed harder".
 */

import type { Diagnosis, Drop, HeaderInfo, RepairPlan, Row } from './types.js'

/** Event types dsh emits as synthetic interrupt-recovery closers. */
const CLOSER_TYPES = new Set(['tool/result', 'step/end', 'turn/end', 'session/end-seed'])

/** A kept-tail block counts as a synthetic closer block only when small and closer-shaped. */
function isCloserBlock(rows: readonly Row[]): boolean {
  const events = rows.reduce((n, r) => n + (r.seqCount ?? 0), 0)
  if (rows.length === 0 || events === 0 || events > 8) return false
  return rows.every(r => r.types.every(t => CLOSER_TYPES.has(t)))
    && rows.some(r => r.types.includes('turn/end'))
}

export interface PlanOptions {
  /** Permit dropping everything from an unfillable seq hole onward. */
  allowTruncate?: boolean
  /** Header to use when the original was unreadable. */
  reconstructedHeader?: HeaderInfo
}

/**
 * Build a repair plan from a diagnosis.
 * @param diagnosis - lenient scan of the damaged artifact.
 * @param options - resolution policy knobs.
 * @returns a plan with line-level keep/drop decisions and validation results.
 */
export function planRepair(diagnosis: Diagnosis, options: PlanOptions = {}): RepairPlan {
  const header = diagnosis.header ?? options.reconstructedHeader
  const errors: string[] = []
  if (header === undefined) {
    errors.push('no readable session header and no reconstructed header supplied')
  }

  const kept: Row[] = []
  const drops: Drop[] = []
  let expected = 0
  let truncated = false

  const rowsBySeqStart = new Map<number, Row>()

  for (const row of diagnosis.rows) {
    if (truncated) {
      drops.push({ line: row.line, reason: 'after-hole', detail: 'after unfillable seq hole' })
      continue
    }
    if (row.parseError !== undefined) {
      drops.push({ line: row.line, reason: 'unparsable', detail: row.parseError })
      continue
    }
    const seq = row.seqStart!
    const count = row.seqCount!

    if (seq === expected) {
      kept.push(row)
      rowsBySeqStart.set(seq, row)
      expected = seq + count
      continue
    }

    if (seq < expected) {
      // Replay. Byte-identical to what we already keep → pure duplicate.
      const committed = rowsBySeqStart.get(seq)
      if (committed !== undefined && committed.raw === row.raw) {
        drops.push({ line: row.line, reason: 'duplicate-replay', detail: `duplicate of line ${committed.line} (seq ${seq})` })
        continue
      }
      // Differing replay: if the committed tail occupying [seq, expected) is a
      // synthetic closer block, the incoming side is the real continuation —
      // drop the closers and accept the row (community-proven zero-loss fix).
      const tailStart = kept.findIndex(r => (r.seqStart ?? 0) >= seq)
      const tail = tailStart === -1 ? [] : kept.slice(tailStart)
      const aligned = tail.length > 0 && tail[0]!.seqStart === seq
      if (aligned && isCloserBlock(tail)) {
        for (const closer of tail) {
          drops.push({
            line: closer.line,
            reason: 'synthetic-closer-block',
            detail: `synthetic interrupt closer (${closer.types.join(',')}) superseded by real continuation at line ${row.line}`,
          })
          rowsBySeqStart.delete(closer.seqStart!)
        }
        kept.length = tailStart
        expected = seq
        kept.push(row)
        rowsBySeqStart.set(seq, row)
        expected = seq + count
        continue
      }
      // Both sides look real. Keep the first-committed version; a replay that
      // would extend past the committed tip cannot be split at line level.
      if (seq + count <= expected) {
        drops.push({ line: row.line, reason: 'colliding-replay', detail: `collides with committed seqs ${seq}..${seq + count - 1}; kept first-committed version` })
        continue
      }
      errors.push(
        `line ${row.line}: replayed row spans seqs ${seq}..${seq + count - 1}, crossing the committed tip ${expected}; `
        + 'cannot be resolved at line granularity — use export to salvage the transcript',
      )
      break
    }

    // seq > expected: a real hole. Nothing can invent the missing events.
    if (options.allowTruncate) {
      truncated = true
      drops.push({ line: row.line, reason: 'after-hole', detail: `truncated at seq hole (expected ${expected}, got ${seq})` })
      continue
    }
    errors.push(
      `line ${row.line}: seq hole (expected ${expected}, got ${seq}); events ${expected}..${seq - 1} are missing. `
      + 'Re-run with --truncate to keep the loadable prefix, or use export to salvage the transcript',
    )
    break
  }

  const resultEvents = expected
  const lostEvents = drops.reduce((n, d) => {
    if (d.reason === 'colliding-replay' || d.reason === 'after-hole' || d.reason === 'unparsable') {
      const row = diagnosis.rows.find(r => r.line === d.line)
      return n + (row?.seqCount ?? 1)
    }
    return n
  }, 0)

  const plan: RepairPlan = {
    header: header ?? { raw: '', version: 0, id: 'unknown', createdAt: 0, reconstructed: true },
    keptLines: kept,
    drops,
    resultEvents,
    lostEvents,
    validated: false,
    validationErrors: errors,
  }
  if (errors.length === 0) validatePlan(plan)
  return plan
}

/** Re-verify the plan's output the way dsh's loader and seed validation would. */
function validatePlan(plan: RepairPlan): void {
  const errors = plan.validationErrors
  let expected = 0
  for (const row of plan.keptLines) {
    if (row.seqStart !== expected) {
      errors.push(`internal: rebuilt log not contiguous at line ${row.line} (expected ${expected}, got ${row.seqStart})`)
      break
    }
    expected += row.seqCount!
    for (const ref of extractSourceRefs(row.raw)) {
      if (ref >= expected) {
        errors.push(
          `line ${row.line}: sourceEventSeq ${ref} references a later/removed event (log tip ${expected}); `
          + 'writing this would poison the session — refusing',
        )
      }
    }
  }
  plan.validated = errors.length === 0
}

/** All sourceEventSeq / sourceEventSeqs values mentioned by a raw row. */
function extractSourceRefs(raw: string): number[] {
  const refs: number[] = []
  for (const match of raw.matchAll(/"sourceEventSeq":(\d+)/g)) refs.push(Number(match[1]))
  for (const match of raw.matchAll(/"sourceEventSeqs":\[([\d,\s]*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length > 0) refs.push(Number(trimmed))
    }
  }
  return refs
}
