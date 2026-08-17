/**
 * Lenient session-log scanning: read everything readable, record every
 * inconsistency, and never throw on damaged data. Mirrors the validation dsh's
 * own loader applies (strict seq contiguity from 0; a break followed by a
 * `turn/end` fails the load) so `fatalForDsh` matches real loader behavior,
 * while additionally accounting for what a rescue can still save.
 */

import type { Diagnosis, HeaderInfo, Issue, Row } from './types.js'
import { decodeFrames, decodeTornPrefix, scanFrames } from './zstd.js'

/** The session format version this build knows how to rescue. */
export const SUPPORTED_FORMAT_VERSION = 0

/** Parse one storage row into its seq coverage without trusting its shape. */
function parseRow(line: number, raw: string): Row {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return { line, raw, types: [], parseError: `not valid JSON: ${(error as Error).message}` }
  }
  if (typeof value !== 'object' || value === null) {
    return { line, raw, types: [], parseError: 'row is not a JSON object' }
  }
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined
  if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
    const seq0 = record.seq0
    const data = record.data as Record<string, unknown> | undefined
    const members = Array.isArray(data?.texts) ? data.texts.length
      : Array.isArray(data?.args) ? data.args.length : undefined
    if (typeof seq0 !== 'number' || members === undefined || members < 1) {
      return { line, raw, types: [type], parseError: `malformed ${type} row` }
    }
    const underlying = type === 'tool-call-chunks' ? 'assistant/chunk' : 'assistant/chunk'
    return { line, raw, seqStart: seq0, seqCount: members, types: [underlying] }
  }
  if (type === undefined || typeof record.seq !== 'number') {
    return { line, raw, types: type ? [type] : [], parseError: 'row has no seq/type' }
  }
  return { line, raw, seqStart: record.seq, seqCount: 1, types: [type] }
}

/** Split decoded plaintext into rows; the caller strips the header line first. */
function toRows(text: string, firstLineNumber: number): Row[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  // A trailing newline yields one empty final element; anything else is a torn tail fragment.
  if (lines.at(-1) === '') lines.pop()
  return lines.map((raw, i) => parseRow(firstLineNumber + i, raw))
}

function parseHeader(line: string): { header?: HeaderInfo; issue?: Issue } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { issue: { kind: 'bad-header', detail: 'header line is not valid JSON', fatalForDsh: true } }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { issue: { kind: 'bad-header', detail: 'header line is not an object', fatalForDsh: true } }
  }
  const h = parsed as Record<string, unknown>
  if (typeof h.version === 'number' && h.version !== SUPPORTED_FORMAT_VERSION) {
    return {
      issue: {
        kind: 'unsupported-version',
        detail: `session format version ${h.version}; this tool rescues version ${SUPPORTED_FORMAT_VERSION} only`,
        fatalForDsh: true,
      },
    }
  }
  if (h.type !== 'session' || typeof h.id !== 'string' || typeof h.createdAt !== 'number') {
    return { issue: { kind: 'bad-header', detail: 'first line is not a session header', fatalForDsh: true } }
  }
  return {
    header: {
      raw: line,
      version: (h.version as number) ?? SUPPORTED_FORMAT_VERSION,
      id: h.id,
      createdAt: h.createdAt,
      ...typeof h.cwd === 'string' ? { cwd: h.cwd } : {},
    },
  }
}

/**
 * Diagnose one session artifact from its raw bytes.
 * @param path - artifact path, echoed into the diagnosis.
 * @param buffer - complete file contents.
 * @returns a lenient full-file diagnosis; never throws on damaged data.
 */
export function diagnose(path: string, buffer: Buffer): Diagnosis {
  const compression: 'zstd' | 'none' = path.endsWith('.zstd') ? 'zstd' : 'none'
  const issues: Issue[] = []
  let text = ''

  if (compression === 'zstd') {
    const scan = scanFrames(buffer)
    const decoded: string[] = []
    for (const [i, frameText] of decodeFrames(buffer, scan.frames).entries()) {
      void i
      decoded.push(frameText)
    }
    text = decoded.join('')
    if (scan.garbageStart !== undefined) {
      issues.push({
        kind: 'frame-corruption',
        detail: `invalid zstd frame structure at byte ${scan.garbageStart}; ${buffer.length - scan.garbageStart} trailing bytes unreadable`,
        fatalForDsh: true,
      })
    }
    if (scan.tornStart !== undefined) {
      const salvaged = decodeTornPrefix(buffer.subarray(scan.tornStart))
      if (salvaged.length > 0) text += salvaged
      issues.push({
        kind: 'torn-tail',
        detail: `incomplete final zstd frame at byte ${scan.tornStart} (dsh self-heals this by truncation on next open)`,
        fatalForDsh: false,
      })
    }
  } else {
    text = buffer.toString('utf8')
  }

  const headerEnd = text.indexOf('\n')
  if (headerEnd === -1) {
    return {
      path, compression, status: 'unreadable', rows: [], loadableEvents: 0,
      salvageableEvents: 0, turns: 0,
      issues: [...issues, { kind: 'bad-header', detail: 'empty or header-less session log', fatalForDsh: true }],
    }
  }
  const { header, issue: headerIssue } = parseHeader(text.slice(0, headerEnd))
  if (headerIssue) issues.push(headerIssue)

  const rows = toRows(text.slice(headerEnd + 1), 1)

  // Walk seq exactly like dsh's loader: contiguous from 0; on a break, later
  // rows are ignored until a turn/end makes the failure fatal.
  let expected = 0
  let loadableEvents = 0
  let salvageable = 0
  let turns = 0
  let lastEventAt: number | undefined
  let broken = false

  for (const row of rows) {
    if (row.parseError !== undefined) {
      if (!broken) {
        issues.push({
          kind: 'unparsable-row',
          line: row.line,
          detail: `unparsable committed event at line ${row.line}: ${row.parseError}`,
          fatalForDsh: true,
        })
        broken = true
      }
      continue
    }
    const seq = row.seqStart!
    const count = row.seqCount!
    salvageable += count
    if (row.types.includes('turn/start') || row.types.includes('turn/end')) turns += 1
    const time = extractTime(row.raw)
    if (time !== undefined) lastEventAt = time

    if (!broken) {
      if (seq !== expected) {
        issues.push({
          kind: seq < expected ? 'seq-overlap' : 'seq-hole',
          line: row.line,
          detail: `seq gap in committed region at line ${row.line} (expected ${expected}, got ${seq})`,
          fatalForDsh: true,
        })
        broken = true
      } else {
        expected += count
        loadableEvents = expected
      }
    }
  }

  const fatal = issues.some(i => i.fatalForDsh)
  const status = issues.some(i => i.kind === 'unsupported-version') ? 'unsupported-version'
    : header === undefined ? 'unreadable'
    : fatal ? 'corrupt'
    : issues.some(i => i.kind === 'torn-tail') ? 'torn-tail'
    : 'ok'

  return {
    path, compression, status, header, rows, issues,
    loadableEvents, salvageableEvents: salvageable, turns: Math.ceil(turns / 2), lastEventAt,
  }
}

/** Pull a plausible epoch-ms time out of a raw row without full decoding. */
function extractTime(raw: string): number | undefined {
  const match = /"time0?":(\d{12,14})/.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}
