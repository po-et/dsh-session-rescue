/**
 * Filesystem discovery for dsh session artifacts:
 * `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl[.zstd]`.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** One discovered session artifact. */
export interface SessionFile {
  path: string
  /** Decoded session id (from the directory name's `~XXXX` escapes). */
  id: string
  /** Project directory name the session is grouped under. */
  projectKey: string
  sizeBytes: number
  mtimeMs: number
}

/** Resolve the dsh home directory: explicit flag, then $DSH_HOME, then ~/.dsh. */
export function resolveHome(explicit?: string): string {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Reverse of dsh's `~XXXX` path-segment escaping. */
export function decodeSegment(encoded: string): string {
  return encoded.replaceAll(/~([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Enumerate every session artifact under a dsh home.
 * @param home - the dsh home directory.
 * @returns discovered artifacts, newest first.
 */
export function listSessions(home: string): SessionFile[] {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const found: SessionFile[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const sessionDir of readdirSync(projectDir, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      for (const candidate of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(projectDir, sessionDir.name, candidate)
        if (existsSync(path)) {
          const stat = statSync(path)
          found.push({
            path,
            id: decodeSegment(sessionDir.name),
            projectKey: project.name,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          })
          break
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Resolve a user-supplied target to one artifact: an existing file path, or a
 * unique session-id substring.
 * @param home - the dsh home directory.
 * @param target - path or id fragment.
 * @returns the matched artifact path.
 */
export function resolveTarget(home: string, target: string): string {
  if (existsSync(target) && statSync(target).isFile()) return target
  const matches = listSessions(home).filter(s => s.id.includes(target))
  if (matches.length === 1) return matches[0]!.path
  if (matches.length === 0) throw new Error(`no session matches "${target}" under ${join(home, 'sessions')}`)
  throw new Error(`"${target}" is ambiguous (${matches.length} matches): ${matches.slice(0, 5).map(m => m.id).join(', ')}${matches.length > 5 ? ', …' : ''}`)
}

/**
 * Move a session's directory out of dsh's sight so a damaged log cannot break
 * workspace startup, preserving it for later rescue.
 * @param home - the dsh home directory.
 * @param artifactPath - the session artifact inside the directory to move.
 * @returns the quarantine destination directory.
 */
export function quarantine(home: string, artifactPath: string): string {
  const sessionDir = dirname(artifactPath)
  const dest = join(home, 'rescue-quarantine', `${Date.now()}-${basename(sessionDir)}`)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(sessionDir, dest)
  return dest
}
