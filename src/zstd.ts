/**
 * Zstandard concatenated-frame container handling for dsh session artifacts.
 *
 * dsh writes `.jsonl.zstd` files as a sequence of independent, checksummed
 * zstd frames: frame 0 holds exactly the one-line session header, and each
 * later frame holds one durable batch of JSONL event lines. Loading rejects a
 * file whose first frame is not exactly one header line, so rebuilds MUST
 * preserve that layout.
 *
 * Frame boundaries are located structurally (RFC 8878 headers and block
 * headers) without decompressing, so a torn final frame can be isolated and
 * partially recovered instead of failing the whole file.
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const SKIPPABLE_MAGIC_MIN = 0x184D2A50
const SKIPPABLE_MAGIC_MAX = 0x184D2A5F

/** Byte range of one structurally complete frame. */
export interface FrameRange {
  start: number
  end: number
}

export interface FrameScan {
  frames: FrameRange[]
  /** Start of an incomplete final frame, when EOF cut one short. */
  tornStart?: number
  /** Offset of bytes that are not a valid frame start, when present. */
  garbageStart?: number
}

/**
 * Locate complete zstd frames without decompressing.
 * Unlike dsh's loader, invalid structure is reported (garbageStart) rather
 * than thrown, so a rescue can keep everything before the damage.
 * @param buffer - complete artifact bytes.
 * @returns complete frame ranges plus torn/garbage boundaries when present.
 */
export function scanFrames(buffer: Buffer): FrameScan {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    const magic = buffer.readUInt32LE(offset)
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      // dsh never writes skippable frames; treat as foreign bytes.
      return { frames, garbageStart: start }
    }
    if (magic !== ZSTD_MAGIC) return { frames, garbageStart: start }
    offset += 4

    if (offset >= buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return { frames, garbageStart: start }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeader = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeader) return { frames, tornStart: start }
    offset += remainingHeader

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return { frames, garbageStart: start }
      const payload = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (lastBlock) break
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decompress each complete frame to text, in order.
 * @param buffer - artifact bytes.
 * @param frames - complete frame ranges from {@link scanFrames}.
 * @returns one plaintext string per frame.
 */
export function decodeFrames(buffer: Buffer, frames: readonly FrameRange[]): string[] {
  return frames.map(f => zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8'))
}

/**
 * Best-effort plaintext from a torn (incomplete) final frame; checksum and
 * final-block completion are deliberately not required.
 * @param torn - bytes from the torn frame start to EOF.
 * @returns whatever plaintext the available blocks yield, possibly empty.
 */
export function decodeTornPrefix(torn: Buffer): string {
  try {
    return zstdDecompressSync(torn, { finishFlush: constants.ZSTD_e_flush }).toString('utf8')
  } catch {
    return ''
  }
}

/** Max event lines per rebuilt frame, keeping frames independently decodable and modest. */
const REBUILD_BATCH_LINES = 2000

/**
 * Rebuild a dsh-layout zstd artifact: frame 0 = exactly the header line,
 * then event lines in batches, every frame checksummed.
 * @param headerLine - header JSON text without trailing newline.
 * @param eventLines - event/storage-row JSON texts without trailing newlines.
 * @returns complete artifact bytes.
 */
export function encodeArtifact(headerLine: string, eventLines: readonly string[]): Buffer {
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const parts: Buffer[] = [zstdCompressSync(headerLine + '\n', opts)]
  for (let i = 0; i < eventLines.length; i += REBUILD_BATCH_LINES) {
    const batch = eventLines.slice(i, i + REBUILD_BATCH_LINES)
    parts.push(zstdCompressSync(batch.join('\n') + '\n', opts))
  }
  return Buffer.concat(parts)
}
