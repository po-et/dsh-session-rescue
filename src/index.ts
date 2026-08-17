/** Programmatic API of dsh-session-rescue. */
export { planRepair, type PlanOptions } from './analyze.js'
export { exportTranscript } from './export.js'
export { decodeSegment, listSessions, quarantine, resolveHome, resolveTarget, type SessionFile } from './locate.js'
export { applyRepair, reconstructHeader, type RepairResult } from './repair.js'
export { diagnose, SUPPORTED_FORMAT_VERSION } from './scan.js'
export type * from './types.js'
export { decodeFrames, decodeTornPrefix, encodeArtifact, scanFrames } from './zstd.js'
