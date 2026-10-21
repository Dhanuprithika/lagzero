import 'fake-indexeddb/auto'
import {
  checkDocumentCacheStatus,
  clearAllCache,
  deleteDocument,
  getDocumentWithChunks,
  listCachedDocuments,
  normalizeUrl,
  openLagZeroDB,
  saveDocumentAndChunks,
} from './src/utils/storage.ts'
import type { ChunkedDocument, ExtractedContent } from './src/types/messaging.ts'

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

async function runStorageTests() {
  console.log('--- Running IndexedDB Storage Unit Tests ---')

  // Test 1: URL Normalization
  {
    const url1 = 'https://example.com/wiki/AI#History'
    const url2 = 'https://example.com/wiki/AI/'
    const url3 = 'https://EXAMPLE.com/wiki/AI'
    const url4 = 'https://example.com/article?id=123&sort=asc#summary'

    assert(normalizeUrl(url1) === 'https://example.com/wiki/AI', 'Fragment should be stripped')
    assert(normalizeUrl(url2) === 'https://example.com/wiki/AI', 'Trailing slash stripped')
    assert(normalizeUrl(url3) === 'https://example.com/wiki/AI', 'Hostname lowercased')
    assert(
      normalizeUrl(url4) === 'https://example.com/article?id=123&sort=asc',
      'Query parameters preserved while fragment stripped'
    )
    console.log('✓ Passed: URL Normalization')
  }

  // Test 2: Database Initialization & Store Creation
  const db = await openLagZeroDB()
  assert(db.name === 'lagzero_local_db', 'Database name matches')
  assert(db.objectStoreNames.contains('documents'), 'Documents store exists')
  assert(db.objectStoreNames.contains('chunks'), 'Chunks store exists')
  console.log('✓ Passed: Database Initialization')

  // Clear before test run
  await clearAllCache(db)

  // Test 3: Save a document and multiple chunks
  const mockExtracted: ExtractedContent = {
    title: 'Artificial Intelligence',
    url: 'https://en.wikipedia.org/wiki/Artificial_intelligence#Overview',
    textContent: 'Paragraph 1 on AI history.\n\nParagraph 2 on modern deep learning.',
    excerpt: 'An overview of AI',
    byline: 'Wikipedia contributors',
    siteName: 'Wikipedia',
    publishedTime: '2026-01-01',
    extractedAt: 1000,
    isTruncated: false,
    originalLength: 68,
  }

  const mockChunked: ChunkedDocument = {
    sourceUrl: mockExtracted.url,
    title: mockExtracted.title,
    totalChunks: 2,
    totalCharacters: 68,
    extractedAt: 1000,
    chunks: [
      {
        id: 'chunk-0',
        index: 0,
        text: 'Paragraph 1 on AI history.',
        characterCount: 26,
        headingContext: 'History',
        documentTitle: mockExtracted.title,
        sourceUrl: mockExtracted.url,
        extractedAt: 1000,
      },
      {
        id: 'chunk-1',
        index: 1,
        text: 'Paragraph 2 on modern deep learning.',
        characterCount: 36,
        headingContext: 'Modern Era',
        documentTitle: mockExtracted.title,
        sourceUrl: mockExtracted.url,
        extractedAt: 1000,
      },
    ],
  }

  const savedDoc = await saveDocumentAndChunks(mockExtracted, mockChunked, db)
  assert(savedDoc.id === 'https://en.wikipedia.org/wiki/Artificial_intelligence', 'Saved doc ID normalized')
  assert(savedDoc.totalChunks === 2, 'Total chunks saved correctly')
  assert(savedDoc.totalCharacters === 68, 'Total characters saved correctly')
  console.log('✓ Passed: Save document and multiple chunks')

  // Test 4: Retrieve document and ordered chunks
  {
    const retrieved = await getDocumentWithChunks(mockExtracted.url, db)
    assert(!!retrieved, 'Document should be retrieved')
    assert(retrieved?.document.title === 'Artificial Intelligence', 'Title retrieved accurately')
    assert(retrieved?.chunks.length === 2, 'All 2 chunks retrieved')
    assert(retrieved?.chunks[0].chunkIndex === 0, 'First chunk index 0')
    assert(retrieved?.chunks[1].chunkIndex === 1, 'Second chunk index 1')
    assert(retrieved?.chunks[0].headingContext === 'History', 'Heading context preserved')
    console.log('✓ Passed: Retrieve document and ordered chunks')
  }

  // Test 5: Check Cache Status
  {
    const statusCached = await checkDocumentCacheStatus(mockExtracted.url, db)
    assert(statusCached.isCached === true, 'Document should be reported as cached')
    assert(statusCached.documentSummary?.totalChunks === 2, 'Summary chunk count matches')

    const statusNotCached = await checkDocumentCacheStatus('https://not-cached.org', db)
    assert(statusNotCached.isCached === false, 'Non-cached URL reported as false')
    console.log('✓ Passed: Check document cache status')
  }

  // Test 6: Update document without duplicate chunks & clean removal of stale chunks
  {
    // Re-saving with only 1 chunk should overwrite previous 2 chunks cleanly
    const updatedChunked: ChunkedDocument = {
      sourceUrl: mockExtracted.url,
      title: 'Artificial Intelligence (Updated)',
      totalChunks: 1,
      totalCharacters: 30,
      extractedAt: 2000,
      chunks: [
        {
          id: 'chunk-0',
          index: 0,
          text: 'Unified single updated paragraph.',
          characterCount: 30,
          headingContext: 'Summary',
          documentTitle: 'Artificial Intelligence (Updated)',
          sourceUrl: mockExtracted.url,
          extractedAt: 2000,
        },
      ],
    }

    const updatedDoc = await saveDocumentAndChunks(
      { ...mockExtracted, title: 'Artificial Intelligence (Updated)' },
      updatedChunked,
      db
    )
    assert(updatedDoc.title === 'Artificial Intelligence (Updated)', 'Title updated')
    assert(updatedDoc.totalChunks === 1, 'Total chunks updated to 1')
    assert(updatedDoc.cachedAt === savedDoc.cachedAt, 'Original cachedAt preserved across updates')
    assert(updatedDoc.updatedAt >= savedDoc.updatedAt, 'updatedAt refreshed')

    const retrievedAfterUpdate = await getDocumentWithChunks(mockExtracted.url, db)
    assert(retrievedAfterUpdate?.chunks.length === 1, 'Obsolete second chunk was removed; exactly 1 remains')
    assert(retrievedAfterUpdate?.chunks[0].text === 'Unified single updated paragraph.', 'New chunk content retrieved')
    console.log('✓ Passed: Update document without duplicates and removal of stale chunks')
  }

  // Test 7: List cached documents
  {
    // Add a second document to test listing
    const docB: ExtractedContent = {
      title: 'Machine Learning',
      url: 'https://example.com/ml',
      textContent: 'ML text content.',
      excerpt: null,
      byline: null,
      siteName: null,
      publishedTime: null,
      extractedAt: 3000,
      isTruncated: false,
      originalLength: 16,
    }
    const chunkedB: ChunkedDocument = {
      sourceUrl: docB.url,
      title: docB.title,
      totalChunks: 1,
      totalCharacters: 16,
      extractedAt: 3000,
      chunks: [
        {
          id: 'chunk-0',
          index: 0,
          text: 'ML text content.',
          characterCount: 16,
          headingContext: null,
          documentTitle: docB.title,
          sourceUrl: docB.url,
          extractedAt: 3000,
        },
      ],
    }
    await saveDocumentAndChunks(docB, chunkedB, db)

    const list = await listCachedDocuments(db)
    assert(list.length === 2, `Expected 2 documents in list, found ${list.length}`)
    // Newest updated document should be first
    assert(list[0].title === 'Machine Learning', 'Most recently updated doc is first')
    console.log('✓ Passed: List cached documents sorted by recency')
  }

  // Test 8: Delete a document and its chunks
  {
    const deleted = await deleteDocument('https://example.com/ml', db)
    assert(deleted === true, 'Delete operation returned true')

    const afterDelete = await getDocumentWithChunks('https://example.com/ml', db)
    assert(afterDelete === null, 'Deleted document is no longer retrievable')

    const list = await listCachedDocuments(db)
    assert(list.length === 1, 'Only 1 document remains in cache')
    console.log('✓ Passed: Delete document and its chunks')
  }

  // Test 9: Clear all cache
  {
    await clearAllCache(db)
    const list = await listCachedDocuments(db)
    assert(list.length === 0, 'All documents cleared from cache')
    const retrieved = await getDocumentWithChunks(mockExtracted.url, db)
    assert(retrieved === null, 'All chunks cleared from cache')
    console.log('✓ Passed: Clear all cache')
  }

  console.log('--- ALL STORAGE TESTS PASSED SUCCESSFULLY ---')
}

runStorageTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
