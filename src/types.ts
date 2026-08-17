/** Shared types for the dsh session-log rescue toolkit. */

/** One physical line of a session log, with its decoded seq coverage. */
export interface Row {
  /** 1-based event-line number (header excluded), matching dsh error messages. */
  line: number
  /** Raw line text, without trailing newline. Kept verbatim for rebuilds. */
  raw: string
  /** Seq of the first event this row carries, or undefined when unparsable. */
  seqStart?: number
  /** Number of events this row expands to (chunk rows cover a run). */
  seqCount?: number
  /** Event types carried by this row (expanded chunk rows report their kind). */
  types: string[]
  /** Parse failure, when JSON.parse or shape decoding rejected the line. */
  parseError?: string
}

/** Session header facts needed for diagnosis and rebuilds. */
export interface HeaderInfo {
  raw: string
  version: number
  id: string
  createdAt: number
  cwd?: string
  /** True when the header was synthesized because the original was unreadable. */
  reconstructed?: boolean
}

export type IssueKind =
  | 'seq-overlap'
  | 'seq-hole'
  | 'unparsable-row'
  | 'bad-header'
  | 'unsupported-version'
  | 'torn-tail'
  | 'frame-corruption'
  | 'shape-poisoning'

/** One detected inconsistency, anchored to where dsh's own loader would fail. */
export interface Issue {
  kind: IssueKind
  /** 1-based event line, when line-anchored. */
  line?: number
  /** Human-readable specifics, including expected/got seqs where relevant. */
  detail: string
  /** Whether dsh's loader fails hard on this issue (vs self-healing/ignoring). */
  fatalForDsh: boolean
}

export type SessionStatus = 'ok' | 'torn-tail' | 'corrupt' | 'unsupported-version' | 'unreadable'

/** Full diagnosis of one session artifact. */
export interface Diagnosis {
  path: string
  compression: 'zstd' | 'none'
  status: SessionStatus
  header?: HeaderInfo
  rows: Row[]
  issues: Issue[]
  /** Count of contiguous-from-zero events dsh can load today. */
  loadableEvents: number
  /** Count of all decodable events, ignoring seq breaks (export upper bound). */
  salvageableEvents: number
  /** Highest turn number observed, best effort. */
  turns: number
  /** Epoch ms of the last decodable event, best effort. */
  lastEventAt?: number
}

/** Line-level decision produced by the overlap resolver. */
export interface Drop {
  line: number
  reason: 'duplicate-replay' | 'synthetic-closer-block' | 'colliding-replay' | 'unparsable' | 'after-hole'
  detail: string
}

/** A validated plan to rebuild a loadable log from kept raw lines. */
export interface RepairPlan {
  header: HeaderInfo
  keptLines: Row[]
  drops: Drop[]
  /** Events in the rebuilt log. */
  resultEvents: number
  /** Events present in the original but absent from the rebuilt log (excluding exact duplicates). */
  lostEvents: number
  /** True when the plan passed post-conditions (contiguity + reference checks). */
  validated: boolean
  validationErrors: string[]
}
