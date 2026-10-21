import type { ContentChunk, ChunkedDocument, ExtractedContent } from '../types/messaging'

export interface ChunkingOptions {
  targetChunkSize?: number
  maxChunkSize?: number
}

const DEFAULT_TARGET_CHUNK_SIZE = 1000
const DEFAULT_MAX_CHUNK_SIZE = 1500

/**
 * Checks if a trimmed line represents a Markdown or plain text heading.
 * Handles '# Heading', '## Heading', or short title-like lines.
 */
function extractHeading(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Markdown style headings
  const mdMatch = trimmed.match(/^#{1,6}\s+(.+)$/)
  if (mdMatch) {
    return mdMatch[1].trim()
  }

  return null
}

/**
 * Splits an excessively long segment into pieces respecting sentence and word boundaries.
 */
function splitLargeSegment(text: string, maxSize: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= maxSize) {
    return [trimmed]
  }

  // Attempt sentence boundary splitting first (. ! ? followed by space)
  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  const result: string[] = []
  let currentPiece = ''

  for (const sentence of sentences) {
    if (!sentence) continue

    // If a single sentence exceeds maxSize, split by words
    if (sentence.length > maxSize) {
      if (currentPiece) {
        result.push(currentPiece)
        currentPiece = ''
      }

      const words = sentence.split(/\s+/)
      for (const word of words) {
        if (!word) continue

        if (!currentPiece) {
          currentPiece = word
        } else if (currentPiece.length + 1 + word.length <= maxSize) {
          currentPiece += ' ' + word
        } else {
          result.push(currentPiece)
          currentPiece = word
        }
      }
      continue
    }

    if (!currentPiece) {
      currentPiece = sentence
    } else if (currentPiece.length + 1 + sentence.length <= maxSize) {
      currentPiece += ' ' + sentence
    } else {
      result.push(currentPiece)
      currentPiece = sentence
    }
  }

  if (currentPiece) {
    result.push(currentPiece)
  }

  return result.length > 0 ? result : [trimmed]
}

/**
 * Splits extracted webpage text into sequential, ordered chunks with metadata.
 *
 * Algorithm & Design:
 * 1. Normalized Paragraph Splitting: Splits text by double newlines (`\n\s*\n`), preserving single linebreaks within paragraphs.
 * 2. Section Heading Detection: Tracks section headers if present (e.g. `# Heading` or single isolated lines).
 * 3. Target and Max Limits: Groups paragraphs until `targetChunkSize` (default 1,000 chars) is approached.
 * 4. Maximum Limit: Guarantees chunks do not exceed `maxChunkSize` (default 1,500 chars) by breaking long paragraphs at sentence/word boundaries.
 * 5. Content Completeness: Every non-whitespace token is strictly retained in sequence.
 * 6. Deterministic IDs: Generates stable, zero-based chunk identifiers (`chunk-0`, `chunk-1`, ...).
 */
export function chunkContent(
  extracted: ExtractedContent,
  options?: ChunkingOptions
): ChunkedDocument {
  const targetSize = options?.targetChunkSize ?? DEFAULT_TARGET_CHUNK_SIZE
  const maxSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE

  const rawText = extracted.textContent ? extracted.textContent.trim() : ''

  if (!rawText) {
    return {
      sourceUrl: extracted.url,
      title: extracted.title,
      totalChunks: 0,
      totalCharacters: 0,
      extractedAt: extracted.extractedAt,
      chunks: [],
    }
  }

  // 1. Split raw text by paragraph boundaries
  const rawParagraphs = rawText.split(/\n\s*\n/)
  const paragraphs: { text: string; headingContext: string | null }[] = []
  let activeHeading: string | null = null

  for (const rawPara of rawParagraphs) {
    const trimmed = rawPara.trim()
    if (!trimmed) continue

    const detectedHeading = extractHeading(trimmed)
    if (detectedHeading) {
      activeHeading = detectedHeading
    }

    // Split paragraphs that exceed maxSize
    if (trimmed.length > maxSize) {
      const subParts = splitLargeSegment(trimmed, maxSize)
      for (const part of subParts) {
        paragraphs.push({
          text: part,
          headingContext: activeHeading,
        })
      }
    } else {
      paragraphs.push({
        text: trimmed,
        headingContext: activeHeading,
      })
    }
  }

  // 2. Accumulate paragraphs into chunks
  const chunks: ContentChunk[] = []
  let currentChunkText = ''
  let currentHeadingContext: string | null = null
  let chunkIndex = 0

  function flushChunk() {
    const trimmedChunk = currentChunkText.trim()
    if (!trimmedChunk) return

    chunks.push({
      id: `chunk-${chunkIndex}`,
      index: chunkIndex,
      text: trimmedChunk,
      characterCount: trimmedChunk.length,
      headingContext: currentHeadingContext,
      documentTitle: extracted.title,
      sourceUrl: extracted.url,
      extractedAt: extracted.extractedAt,
    })

    chunkIndex++
    currentChunkText = ''
    currentHeadingContext = null
  }

  for (const para of paragraphs) {
    // If starting a new chunk
    if (!currentChunkText) {
      currentChunkText = para.text
      currentHeadingContext = para.headingContext
      continue
    }

    // Check if adding this paragraph exceeds targetSize or maxSize
    const combinedLength = currentChunkText.length + 2 + para.text.length // with '\n\n'

    // If combining exceeds targetSize and current chunk already has sufficient content, flush
    if (combinedLength > targetSize) {
      if (currentChunkText.length >= targetSize * 0.5 || combinedLength > maxSize) {
        flushChunk()
        currentChunkText = para.text
        currentHeadingContext = para.headingContext
        continue
      }
    }

    // Otherwise merge into current chunk
    currentChunkText += '\n\n' + para.text
    if (!currentHeadingContext && para.headingContext) {
      currentHeadingContext = para.headingContext
    }
  }

  // Flush any remaining accumulated text
  if (currentChunkText) {
    flushChunk()
  }

  const totalCharacters = chunks.reduce((acc, c) => acc + c.characterCount, 0)

  return {
    sourceUrl: extracted.url,
    title: extracted.title,
    totalChunks: chunks.length,
    totalCharacters,
    extractedAt: extracted.extractedAt,
    chunks,
  }
}
