import type { CachedChunk, CachedDocument, SearchOptions, SearchResult } from '../types/messaging'
import { getAllCachedDocumentsAndChunks } from './storage'

/**
 * Normalizes query string:
 * - Trims leading/trailing whitespace
 * - Converts to lower-case
 * - Splits on whitespace and non-alphanumeric separators
 * - Filters out empty tokens
 * - Deduplicates tokens
 */
export function normalizeQuery(query: string): { normalizedQuery: string; tokens: string[] } {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return { normalizedQuery: '', tokens: [] }
  }

  // Tokenize by whitespace and non-alphanumeric punctuation (including hyphens and underscores)
  const rawTokens = trimmed
    .split(/[\s\-_,.;:!?'"()[\]{}<>\\/`~@#$%^&*+=|]+/)
    .filter((token) => token.length > 0)

  // Deduplicate tokens while preserving order
  const uniqueTokens: string[] = []
  const seen = new Set<string>()
  for (const token of rawTokens) {
    if (!seen.has(token)) {
      seen.add(token)
      uniqueTokens.push(token)
    }
  }

  return {
    normalizedQuery: trimmed,
    tokens: uniqueTokens,
  }
}

/**
 * Counts occurrences of a sub-string within target text (case-insensitive).
 */
function countOccurrences(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let pos = 0
  const lowerText = text.toLowerCase()
  const lowerTerm = term.toLowerCase()

  while ((pos = lowerText.indexOf(lowerTerm, pos)) !== -1) {
    count++
    pos += lowerTerm.length
  }
  return count
}

/**
 * Relevance scoring function:
 * 1. Exact phrase match: +50 points if whole query appears in chunk text; +25 if in heading; +35 in title.
 * 2. Title term match: +20 points per distinct query token in document title.
 * 3. Heading context match: +10 points per distinct query token in section/heading context.
 * 4. Distinct terms in passage: +15 points per matched unique query token.
 * 5. Term frequency in passage: +3 points per occurrence (capped at 30 points to avoid repetition abuse).
 * 6. Query coverage bonus: +25 bonus points if 100% of multi-word query tokens match.
 */
export function scorePassage(
  chunk: CachedChunk,
  doc: CachedDocument,
  query: string,
  tokens: string[]
): { score: number; matchedTerms: string[]; exactPhraseMatch: boolean; titleMatch: boolean } {
  if (tokens.length === 0) {
    return { score: 0, matchedTerms: [], exactPhraseMatch: false, titleMatch: false }
  }

  const chunkTextLower = chunk.text.toLowerCase()
  const headingLower = (chunk.headingContext ?? '').toLowerCase()
  const titleLower = doc.title.toLowerCase()
  const queryLower = query.toLowerCase()

  let score = 0
  const matchedTerms: string[] = []
  let exactPhraseMatch = false
  let titleMatch = false

  // 1. Exact Phrase Match
  if (queryLower.length > 1 && queryLower.includes(' ')) {
    if (chunkTextLower.includes(queryLower)) {
      score += 50
      exactPhraseMatch = true
    }
    if (headingLower.includes(queryLower)) {
      score += 25
      exactPhraseMatch = true
    }
    if (titleLower.includes(queryLower)) {
      score += 35
      exactPhraseMatch = true
      titleMatch = true
    }
  }

  // 2. Token Matching
  let totalTermOccurrencesInChunk = 0

  for (const token of tokens) {
    const inTitle = titleLower.includes(token)
    const inHeading = headingLower.includes(token)
    const inChunk = chunkTextLower.includes(token)

    if (inTitle) {
      score += 20
      titleMatch = true
    }

    if (inHeading) {
      score += 10
    }

    if (inChunk) {
      const occurrences = countOccurrences(chunkTextLower, token)
      totalTermOccurrencesInChunk += occurrences
      score += 15 // Distinct token match in passage
      matchedTerms.push(token)
    } else if (inTitle || inHeading) {
      matchedTerms.push(token)
    }
  }

  // Term frequency capped contribution (max 30 pts)
  score += Math.min(totalTermOccurrencesInChunk * 3, 30)

  // Full coverage bonus: if all tokens matched somewhere
  if (tokens.length > 1 && matchedTerms.length >= tokens.length) {
    score += 25
  }

  return {
    score,
    matchedTerms,
    exactPhraseMatch,
    titleMatch,
  }
}

/**
 * Searches locally cached documents and passages from IndexedDB.
 * Works completely offline with zero network requests.
 *
 * Scoring and Ranking:
 * - Scored by relevance formula (phrase matches, title boost, term coverage, frequency).
 * - Deterministic tie-breaking: Higher score -> document title (alphabetical) -> chunk index (ascending).
 * - Options support `limit` (default: 20).
 */
export async function searchCachedContent(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 20, dbInstance } = options
  const { normalizedQuery, tokens } = normalizeQuery(query)

  if (tokens.length === 0) {
    return []
  }

  // Retrieve all valid cached documents and chunks in one readonly transaction
  const { documents, chunks } = await getAllCachedDocumentsAndChunks(dbInstance)

  if (documents.size === 0 || chunks.length === 0) {
    return []
  }

  const results: SearchResult[] = []

  for (const chunk of chunks) {
    const parentDoc = documents.get(chunk.documentId)
    if (!parentDoc) {
      continue // Skip chunk if parent doc is not in valid documents set
    }

    const { score, matchedTerms, exactPhraseMatch, titleMatch } = scorePassage(
      chunk,
      parentDoc,
      normalizedQuery,
      tokens
    )

    if (score > 0 && matchedTerms.length > 0) {
      results.push({
        documentId: parentDoc.id,
        documentTitle: parentDoc.title,
        sourceUrl: parentDoc.sourceUrl,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        passageText: chunk.text,
        characterCount: chunk.characterCount,
        relevanceScore: score,
        matchedTerms,
        headingContext: chunk.headingContext,
        cachedAt: parentDoc.cachedAt,
        updatedAt: parentDoc.updatedAt,
        exactPhraseMatch,
        titleMatch,
      })
    }
  }

  // Deterministic Ranking:
  // 1. Relevance score descending
  // 2. Document title ascending (case-insensitive)
  // 3. Chunk index ascending
  results.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore
    }
    const titleCompare = a.documentTitle.localeCompare(b.documentTitle)
    if (titleCompare !== 0) {
      return titleCompare
    }
    return a.chunkIndex - b.chunkIndex
  })

  // Apply limit
  return results.slice(0, Math.max(1, limit))
}
