/**
 * Plan application: backup the original artifact, rebuild the log in dsh's
 * physical layout (zstd: header-only frame 0 + batched event frames;
 * plaintext: plain JSONL), and swap it in atomically. The original bytes are
 * always preserved beside the repaired file.
 */

import { copyFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { HeaderInfo, RepairPlan } from './types.js'
import { encodeArtifact } from './zstd.js'

export interface RepairResult {
  backupPath: string
  bytesWritten: number
}

/**
 * Write the repaired artifact.
 * @param path - the damaged artifact's path; repaired bytes replace it in place.
 * @param plan - a plan whose `validated` flag is true (throws otherwise).
 * @returns backup location and output size.
 */
export function applyRepair(path: string, plan: RepairPlan): RepairResult {
  if (!plan.validated) {
    throw new Error(`refusing to write an unvalidated plan: ${plan.validationErrors.join('; ') || 'unknown reason'}`)
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  const backupPath = `${path}.rescue-backup-${stamp}`
  copyFileSync(path, backupPath)

  const eventLines = plan.keptLines.map(row => row.raw)
  const output = path.endsWith('.zstd')
    ? encodeArtifact(plan.header.raw, eventLines)
    : Buffer.from([plan.header.raw, ...eventLines].join('\n') + '\n', 'utf8')

  const tempPath = `${path}.rescue-tmp`
  writeFileSync(tempPath, output)
  renameSync(tempPath, path)
  return { backupPath, bytesWritten: statSync(path).size }
}

/**
 * Synthesize a loadable header when the original is unreadable, in dsh's
 * field order. The session id comes from the artifact's directory name; the
 * creation time from the earliest decodable event or the file mtime.
 * @param id - decoded session id.
 * @param createdAt - epoch ms for the header's createdAt.
 * @returns a header marked as reconstructed.
 */
export function reconstructHeader(id: string, createdAt: number): HeaderInfo {
  const line = JSON.stringify({ type: 'session', version: 0, id, createdAt, delegationDepth: 0 })
  return { raw: line, version: 0, id, createdAt, reconstructed: true }
}
