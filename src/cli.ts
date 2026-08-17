#!/usr/bin/env node
/**
 * dsh-session-rescue CLI: scan, diagnose, repair, and salvage DeepSeek
 * Harness session logs.
 *
 * Commands:
 *   scan                       health-check every session under the dsh home (default)
 *   doctor <target>            deep-diagnose one session (path or id fragment)
 *   repair <target>            plan a safe repair; add --apply to write it
 *   export <target> [--out f]  salvage the transcript to Markdown
 *   quarantine <target>        move a broken session dir out of dsh's sight
 * Flags: --home <dir>  --json  --truncate  --apply  --out <file>
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { planRepair } from './analyze.js'
import { exportTranscript } from './export.js'
import { decodeSegment, listSessions, quarantine, resolveHome, resolveTarget } from './locate.js'
import { applyRepair, reconstructHeader } from './repair.js'
import { diagnose } from './scan.js'
import type { Diagnosis } from './types.js'

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined
const paint = (code: string, text: string) => useColor ? `[${code}m${text}[0m` : text
const green = (t: string) => paint('32', t)
const yellow = (t: string) => paint('33', t)
const red = (t: string) => paint('31', t)
const bold = (t: string) => paint('1', t)
const dim = (t: string) => paint('2', t)

interface Args {
  command: string
  target?: string
  home?: string
  json: boolean
  apply: boolean
  truncate: boolean
  out?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'scan', json: false, apply: false, truncate: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') args.json = true
    else if (arg === '--apply' || arg === '--yes') args.apply = true
    else if (arg === '--truncate') args.truncate = true
    else if (arg === '--home') args.home = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    else if (arg.startsWith('--')) fail(`unknown flag ${arg} (see --help)`)
    else positional.push(arg)
  }
  const commands = new Set(['scan', 'doctor', 'repair', 'export', 'quarantine'])
  if (positional.length > 0 && commands.has(positional[0]!)) args.command = positional.shift()!
  args.target = positional.shift()
  if (positional.length > 0) fail(`unexpected argument ${positional[0]}`)
  if (args.command !== 'scan' && args.target === undefined) fail(`${args.command} needs a <target> (session path or id fragment)`)
  return args
}

function printHelp(): void {
  console.log(`dsh-session-rescue — diagnose, repair and salvage DeepSeek Harness session logs

Usage:
  npx dsh-session-rescue                   scan every session under the dsh home
  npx dsh-session-rescue doctor <target>   deep-diagnose one session
  npx dsh-session-rescue repair <target>   show the repair plan (add --apply to write)
  npx dsh-session-rescue export <target>   salvage the transcript to Markdown
  npx dsh-session-rescue quarantine <target>  move a broken session out of dsh's sight

<target> is a session file path or a session-id fragment.
Flags:
  --home <dir>   dsh home (default: $DSH_HOME or ~/.dsh)
  --apply        actually write the repair (a timestamped backup is always kept)
  --truncate     allow dropping events after an unfillable seq hole
  --out <file>   export destination (default: <session-id>.md)
  --json         machine-readable output

The repair never touches the original without a backup, and refuses to write
any output that fails contiguity or sourceEventSeq reference validation.`)
}

function fail(message: string): never {
  console.error(red(`error: ${message}`))
  process.exit(1)
}

function statusLabel(status: Diagnosis['status']): string {
  switch (status) {
    case 'ok': return green('OK')
    case 'torn-tail': return yellow('TORN TAIL (self-heals)')
    case 'corrupt': return red('CORRUPT')
    case 'unsupported-version': return yellow('UNSUPPORTED VERSION')
    case 'unreadable': return red('UNREADABLE')
  }
}

function loadDiagnosis(path: string): Diagnosis {
  return diagnose(path, readFileSync(path))
}

function sessionIdFromPath(path: string): string {
  return decodeSegment(basename(dirname(path)))
}

function runScan(args: Args): void {
  const home = resolveHome(args.home)
  const sessions = listSessions(home)
  if (sessions.length === 0) {
    console.log(`no sessions found under ${home}/sessions`)
    return
  }
  const results = sessions.map(s => ({ session: s, diagnosis: loadDiagnosis(s.path) }))
  if (args.json) {
    console.log(JSON.stringify(results.map(({ session, diagnosis }) => ({
      id: session.id,
      path: session.path,
      status: diagnosis.status,
      events: diagnosis.loadableEvents,
      salvageable: diagnosis.salvageableEvents,
      issues: diagnosis.issues.map(i => ({ kind: i.kind, line: i.line, detail: i.detail })),
    })), null, 2))
    return
  }
  const broken = results.filter(r => r.diagnosis.status === 'corrupt' || r.diagnosis.status === 'unreadable')
  console.log(bold(`Scanned ${results.length} session(s) under ${home}/sessions\n`))
  for (const { session, diagnosis } of results) {
    const size = `${(session.sizeBytes / 1024).toFixed(0)}KB`
    console.log(`  ${statusLabel(diagnosis.status).padEnd(useColor ? 32 : 22)} ${session.id}  ${dim(`${diagnosis.loadableEvents} events, ${size}`)}`)
    for (const issue of diagnosis.issues.filter(i => i.fatalForDsh)) {
      console.log(`      ${red('✗')} ${issue.detail}`)
    }
  }
  console.log('')
  if (broken.length === 0) {
    console.log(green('All sessions load cleanly.'))
  } else {
    console.log(red(`${broken.length} session(s) cannot be loaded by dsh.`))
    console.log(`Next: ${bold(`npx dsh-session-rescue repair "${broken[0]!.session.id.slice(0, 20)}"`)}  (plan first, --apply to write)`)
    process.exitCode = 2
  }
}

function buildPlan(diagnosisPath: string, args: Args) {
  const diagnosis = loadDiagnosis(diagnosisPath)
  let reconstructed
  if (diagnosis.header === undefined) {
    const firstTime = diagnosis.lastEventAt !== undefined
      ? diagnosis.rows.map(r => r.raw).map(raw => /"time0?":(\d{12,14})/.exec(raw)).find(m => m !== null)
      : undefined
    const createdAt = firstTime ? Number(firstTime[1]) : Math.round(statSync(diagnosisPath).mtimeMs)
    reconstructed = reconstructHeader(sessionIdFromPath(diagnosisPath), createdAt)
  }
  return { diagnosis, plan: planRepair(diagnosis, { allowTruncate: args.truncate, reconstructedHeader: reconstructed }) }
}

function runDoctor(args: Args): void {
  const home = resolveHome(args.home)
  const path = resolveTarget(home, args.target!)
  const { diagnosis, plan } = buildPlan(path, args)
  if (args.json) {
    console.log(JSON.stringify({
      path,
      status: diagnosis.status,
      compression: diagnosis.compression,
      header: diagnosis.header ?? null,
      loadableEvents: diagnosis.loadableEvents,
      salvageableEvents: diagnosis.salvageableEvents,
      issues: diagnosis.issues,
      repairable: plan.validated,
      repairPlan: plan.validated ? { kept: plan.resultEvents, drops: plan.drops, lostEvents: plan.lostEvents } : null,
      repairBlockers: plan.validationErrors,
    }, null, 2))
    return
  }
  console.log(`${bold('Session:')} ${sessionIdFromPath(path)}`)
  console.log(`${bold('File:')} ${path} ${dim(`(${diagnosis.compression})`)}`)
  console.log(`${bold('Status:')} ${statusLabel(diagnosis.status)}`)
  console.log(`${bold('Events:')} ${diagnosis.loadableEvents} loadable by dsh today / ${diagnosis.salvageableEvents} salvageable`)
  if (diagnosis.issues.length > 0) {
    console.log(`\n${bold('Issues:')}`)
    for (const issue of diagnosis.issues) {
      const mark = issue.fatalForDsh ? red('✗ fatal ') : yellow('△ benign')
      console.log(`  ${mark} [${issue.kind}]${issue.line !== undefined ? ` line ${issue.line}` : ''}: ${issue.detail}`)
    }
  }
  console.log('')
  if (diagnosis.status === 'ok') console.log(green('Nothing to repair.'))
  else if (diagnosis.status === 'torn-tail') console.log(yellow('dsh repairs torn tails by itself on next open — no action needed.'))
  else if (plan.validated) {
    console.log(green(`Repairable: ${plan.resultEvents} events kept, ${plan.drops.length} line(s) dropped, ${plan.lostEvents} event(s) lost.`))
    console.log(`Next: ${bold(`npx dsh-session-rescue repair "${args.target}" --apply`)}`)
  } else {
    console.log(red('Not auto-repairable:'))
    for (const err of plan.validationErrors) console.log(`  ${err}`)
    console.log(`Salvage the conversation instead: ${bold(`npx dsh-session-rescue export "${args.target}"`)}`)
  }
}

function runRepair(args: Args): void {
  const home = resolveHome(args.home)
  const path = resolveTarget(home, args.target!)
  const { diagnosis, plan } = buildPlan(path, args)
  if (diagnosis.status === 'ok') { console.log(green('Session already loads cleanly — nothing to do.')); return }
  if (diagnosis.status === 'torn-tail') { console.log(yellow('Only a torn tail: dsh self-heals this on next open — nothing to do.')); return }
  if (!plan.validated) {
    console.log(red('Refusing to repair — the plan failed validation:'))
    for (const err of plan.validationErrors) console.log(`  ${err}`)
    process.exit(1)
  }
  console.log(bold(`Repair plan for ${sessionIdFromPath(path)}:`))
  console.log(`  keep  ${plan.resultEvents} events (${plan.keptLines.length} lines)`)
  for (const drop of plan.drops) console.log(`  drop  line ${drop.line} ${dim(`[${drop.reason}]`)} ${drop.detail}`)
  if (plan.header.reconstructed === true) console.log(yellow('  header was unreadable and will be reconstructed (cwd is not recoverable)'))
  console.log(`  lost  ${plan.lostEvents} event(s) of real content`)
  if (!args.apply) {
    console.log(`\n${dim('Dry run.')} Add ${bold('--apply')} to write (a timestamped backup is kept). Close dsh first.`)
    return
  }
  const result = applyRepair(path, plan)
  const check = loadDiagnosis(path)
  if (check.status === 'ok' || check.status === 'torn-tail') {
    console.log(green(`\nRepaired. ${check.loadableEvents} events now load. Backup: ${result.backupPath}`))
  } else {
    console.log(red(`\nPost-repair verification failed (${check.status}) — restoring is possible from ${result.backupPath}. Please report this.`))
    process.exit(1)
  }
}

function runExport(args: Args): void {
  const home = resolveHome(args.home)
  const path = resolveTarget(home, args.target!)
  const diagnosis = loadDiagnosis(path)
  const markdown = exportTranscript(diagnosis)
  const out = args.out ?? `${sessionIdFromPath(path)}.md`
  writeFileSync(out, markdown)
  console.log(green(`Salvaged transcript (${diagnosis.salvageableEvents} events scanned) → ${out}`))
}

function runQuarantine(args: Args): void {
  const home = resolveHome(args.home)
  const path = resolveTarget(home, args.target!)
  const dest = quarantine(home, path)
  console.log(green(`Moved ${dirname(path)}\n  → ${dest}`))
  console.log('dsh will no longer see this session; rescue it later from the quarantine directory.')
}

const args = parseArgs(process.argv.slice(2))
try {
  if (args.command === 'scan') runScan(args)
  else if (args.command === 'doctor') runDoctor(args)
  else if (args.command === 'repair') runRepair(args)
  else if (args.command === 'export') runExport(args)
  else runQuarantine(args)
} catch (error) {
  fail((error as Error).message)
}
