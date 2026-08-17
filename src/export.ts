/**
 * Best-effort transcript salvage: extract the human-readable conversation
 * from any session log, reading straight past seq breaks and damage. When a
 * session cannot be repaired, its words still can.
 *
 * Extraction is deliberately defensive about event payload shapes — this tool
 * targets a pre-1.0 format with no compatibility promise, so unknown shapes
 * degrade to omission, never to a crash.
 */

import type { Diagnosis } from './types.js'

/** Collect visible text from a value that may be a string, block array, or message object. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('')
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    if (typeof v.text === 'string') return v.text
    if (v.content !== undefined) return textOf(v.content)
    if (v.message !== undefined) return textOf(v.message)
  }
  return ''
}

/**
 * Render a salvaged Markdown transcript.
 * @param diagnosis - lenient scan whose rows are read regardless of seq breaks.
 * @returns Markdown text of the recoverable conversation.
 */
export function exportTranscript(diagnosis: Diagnosis): string {
  const lines: string[] = []
  const id = diagnosis.header?.id ?? 'unknown session'
  lines.push(`# Salvaged transcript — ${id}`, '')
  if (diagnosis.status !== 'ok') {
    lines.push(`> Salvaged by dsh-session-rescue from a \`${diagnosis.status}\` log; ${diagnosis.issues.length} issue(s) were bypassed.`, '')
  }

  let assistantBuffer = ''
  let sawFinalAssistantMessage = false
  const flushAssistant = () => {
    if (assistantBuffer.trim().length > 0 && !sawFinalAssistantMessage) {
      lines.push('**Assistant** (streamed, no final message recorded):', '', assistantBuffer.trim(), '')
    }
    assistantBuffer = ''
    sawFinalAssistantMessage = false
  }

  for (const row of diagnosis.rows) {
    if (row.parseError !== undefined) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(row.raw) as Record<string, unknown>
    } catch {
      continue
    }
    const type = record.type as string

    if (type === 'turn/start') {
      flushAssistant()
      lines.push(`---`, '', `## Turn ${(record as { turn?: number }).turn ?? '?'}`, '')
    } else if (type === 'user/message') {
      flushAssistant()
      const text = textOf(record)
      if (text) lines.push('**User:**', '', text.trim(), '')
    } else if (type === 'assistant/message') {
      const text = textOf(record)
      if (text) {
        lines.push('**Assistant:**', '', text.trim(), '')
        sawFinalAssistantMessage = true
        assistantBuffer = ''
      }
    } else if (type === 'text-chunks') {
      const data = record.data as { texts?: unknown } | undefined
      if (Array.isArray(data?.texts)) assistantBuffer += data.texts.filter(t => typeof t === 'string').join('')
    } else if (type === 'assistant/chunk') {
      const chunk = record.chunk as Record<string, unknown> | undefined
      if (chunk !== undefined && typeof chunk.text === 'string' && chunk.type !== 'reasoning-delta') {
        assistantBuffer += chunk.text
      }
    } else if (type === 'tool/call') {
      const name = typeof record.name === 'string' ? record.name : 'tool'
      const args = typeof record.arguments === 'string' ? record.arguments : ''
      const preview = args.length > 160 ? `${args.slice(0, 160)}…` : args
      lines.push(`> 🔧 \`${name}\` ${preview ? `\`${preview.replaceAll('`', "'")}\`` : ''}`, '')
    }
  }
  flushAssistant()
  return lines.join('\n')
}
