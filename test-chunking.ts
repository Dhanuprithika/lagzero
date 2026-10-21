import { chunkContent } from './src/utils/chunkContent.ts'
import type { ExtractedContent } from './src/types/messaging.ts'

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

console.log('--- Running chunkContent Unit Tests ---')

// 1. Empty and whitespace-only input
{
  const mock: ExtractedContent = {
    title: 'Empty Page',
    url: 'https://example.com/empty',
    textContent: '   \n\n  \t  ',
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 1000,
    isTruncated: false,
    originalLength: 0,
  }
  const result = chunkContent(mock)
  assert(result.totalChunks === 0, 'Empty input should yield 0 chunks')
  assert(result.chunks.length === 0, 'Chunks array should be empty')
  console.log('✓ Passed: Empty and whitespace-only input')
}

// 2. Short article that fits in one chunk
{
  const mock: ExtractedContent = {
    title: 'Short Note',
    url: 'https://example.com/short',
    textContent: 'This is a brief piece of text that easily fits in a single chunk.',
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 1000,
    isTruncated: false,
    originalLength: 65,
  }
  const result = chunkContent(mock)
  assert(result.totalChunks === 1, 'Short text should yield exactly 1 chunk')
  assert(result.chunks[0].index === 0, 'Index should be 0')
  assert(result.chunks[0].id === 'chunk-0', 'ID should be chunk-0')
  assert(result.chunks[0].text === mock.textContent, 'Text should match exactly')
  assert(result.chunks[0].characterCount === mock.textContent.length, 'Character count should match')
  assert(result.chunks[0].documentTitle === 'Short Note', 'Title propagated')
  assert(result.chunks[0].sourceUrl === 'https://example.com/short', 'Source URL propagated')
  console.log('✓ Passed: Short article in one chunk')
}

// 3. Multiple paragraphs and reading order
{
  const p1 = 'Paragraph 1: Introduction to artificial intelligence and automated reasoning.'
  const p2 = 'Paragraph 2: Modern deep learning architectures revolutionized computer vision and NLP.'
  const p3 = 'Paragraph 3: Ongoing challenges include alignment, verification, and efficiency.'
  const textContent = `${p1}\n\n${p2}\n\n${p3}`

  const mock: ExtractedContent = {
    title: 'AI Overview',
    url: 'https://example.com/ai',
    textContent,
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 2000,
    isTruncated: false,
    originalLength: textContent.length,
  }
  // With targetChunkSize=100, these should be separated into multiple chunks
  const result = chunkContent(mock, { targetChunkSize: 100, maxChunkSize: 200 })
  assert(result.totalChunks === 3, `Expected 3 chunks with target size 100, got ${result.totalChunks}`)
  assert(result.chunks[0].text === p1, 'First chunk should be Paragraph 1')
  assert(result.chunks[1].text === p2, 'Second chunk should be Paragraph 2')
  assert(result.chunks[2].text === p3, 'Third chunk should be Paragraph 3')
  assert(result.chunks[0].index === 0 && result.chunks[1].index === 1 && result.chunks[2].index === 2, 'Indices ordered 0, 1, 2')
  console.log('✓ Passed: Multiple paragraphs and reading order')
}

// 4. Long paragraph exceeding maximum chunk size
{
  const sentenceA = 'This is the first long sentence designed to test the boundary.'
  const sentenceB = 'This is the second sentence that will push past the max chunk size limit.'
  const sentenceC = 'This is the third sentence that completes the test sequence cleanly.'
  const longParagraph = `${sentenceA} ${sentenceB} ${sentenceC}`

  const mock: ExtractedContent = {
    title: 'Long Paragraph Test',
    url: 'https://example.com/long',
    textContent: longParagraph,
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 3000,
    isTruncated: false,
    originalLength: longParagraph.length,
  }

  // Force maxChunkSize to 80 chars
  const result = chunkContent(mock, { targetChunkSize: 60, maxChunkSize: 80 })
  assert(result.totalChunks > 1, 'Long paragraph should be split into multiple chunks')
  for (const chunk of result.chunks) {
    assert(chunk.characterCount <= 80, `Chunk exceeds maxChunkSize: ${chunk.characterCount}`)
  }
  // Verify all sentences are present in combined chunk output
  const combined = result.chunks.map((c) => c.text).join(' ')
  assert(combined.includes(sentenceA), 'sentenceA preserved')
  assert(combined.includes(sentenceB), 'sentenceB preserved')
  assert(combined.includes(sentenceC), 'sentenceC preserved')
  console.log('✓ Passed: Long paragraph splitting at sentence boundaries')
}

// 5. Heading and section context tracking
{
  const textWithHeadings = `# History of Computing\n\nCharles Babbage designed the Analytical Engine in the 19th century.\n\n# Modern Era\n\nTuring machines formalized algorithms and computability.`
  const mock: ExtractedContent = {
    title: 'Computing',
    url: 'https://example.com/computing',
    textContent: textWithHeadings,
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 4000,
    isTruncated: false,
    originalLength: textWithHeadings.length,
  }
  const result = chunkContent(mock, { targetChunkSize: 50, maxChunkSize: 100 })
  assert(result.totalChunks >= 2, 'Should have multiple chunks')
  assert(result.chunks[0].headingContext === 'History of Computing', `Heading context preserved on chunk 0: ${result.chunks[0].headingContext}`)
  const modernChunk = result.chunks.find((c) => c.text.includes('Turing'))
  assert(!!modernChunk, 'Chunk with Turing exists')
  assert(modernChunk?.headingContext === 'Modern Era', `Heading context on Modern Era chunk: ${modernChunk?.headingContext}`)
  console.log('✓ Passed: Heading and section context tracking')
}

// 6. Content completeness and non-whitespace preservation
{
  const raw = 'Alpha beta gamma.\n\nDelta epsilon zeta.\n\nEta theta iota.'
  const mock: ExtractedContent = {
    title: 'Greek',
    url: 'https://example.com/greek',
    textContent: raw,
    excerpt: null,
    byline: null,
    siteName: null,
    publishedTime: null,
    extractedAt: 5000,
    isTruncated: false,
    originalLength: raw.length,
  }
  const result = chunkContent(mock, { targetChunkSize: 20, maxChunkSize: 40 })
  const reconstructedWords = result.chunks.flatMap((c) => c.text.split(/\s+/)).filter(Boolean)
  const originalWords = raw.split(/\s+/).filter(Boolean)
  assert(
    JSON.stringify(reconstructedWords) === JSON.stringify(originalWords),
    'All non-whitespace words preserved in exact sequence'
  )
  console.log('✓ Passed: Content completeness and non-whitespace preservation')
}

console.log('--- ALL TESTS PASSED SUCCESSFULLY ---')
