import 'fake-indexeddb/auto'
import { chunkContent } from './src/utils/chunkContent'
import { searchCachedContent } from './src/utils/search'
import {
  clearAllCache,
  deleteDocument,
  getDocumentWithChunks,
  listCachedDocuments,
  openLagZeroDB,
  saveDocumentAndChunks,
} from './src/utils/storage'
import type { ExtractedContent } from './src/types/messaging'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function runIntegrationTests() {
  console.log('--- Running Phase 1 End-to-End Integration Tests ---')

  const db = await openLagZeroDB()
  await clearAllCache(db)

  // Step 1: Simulated Clean Extraction of 2 Real-world Articles
  const article1: ExtractedContent = {
    title: 'Artificial Intelligence and Natural Language Processing',
    byline: 'Alan Turing',
    dir: 'ltr',
    content: '<p>Artificial intelligence enables computers to understand human language.</p>',
    textContent:
      'Artificial intelligence enables computers to understand human language.\n\n' +
      'Natural language processing involves parsing sentences, tokenizing words, and semantic representation.\n\n' +
      'Neural network architectures like transformers have revolutionized sequence modeling.',
    length: 275,
    excerpt: 'AI and NLP overview',
    siteName: 'AI Research',
    publishedTime: null,
    url: 'https://example.org/articles/ai-nlp',
    isTruncated: false,
    originalLength: 275,
  }

  const article2: ExtractedContent = {
    title: 'Quantum Computing and Cryptography',
    byline: 'Richard Feynman',
    dir: 'ltr',
    content: '<p>Quantum computers leverage superposition and entanglement.</p>',
    textContent:
      'Quantum computers leverage superposition and entanglement to execute complex calculations.\n\n' +
      'Post-quantum cryptography develops lattice-based cryptographic algorithms resilient to quantum attacks.',
    length: 220,
    excerpt: 'Quantum computing introduction',
    siteName: 'Quantum Weekly',
    publishedTime: null,
    url: 'https://example.org/articles/quantum-crypto',
    isTruncated: false,
    originalLength: 220,
  }

  // Step 2: Chunk Both Articles
  const chunked1 = chunkContent(article1, {
    targetChunkSize: 100,
    maxChunkSize: 200,
  })
  assert(chunked1.totalChunks >= 2, 'Article 1 chunked into multiple segments')

  const chunked2 = chunkContent(article2, {
    targetChunkSize: 100,
    maxChunkSize: 200,
  })
  assert(chunked2.totalChunks >= 1, 'Article 2 chunked successfully')
  console.log('✓ Passed: Content extraction to chunking pipeline')

  // Step 3: Save to IndexedDB
  await saveDocumentAndChunks(article1, chunked1, db)
  await saveDocumentAndChunks(article2, chunked2, db)

  const cachedList = await listCachedDocuments(db)
  assert(cachedList.length === 2, 'Both documents listed in local cache')
  assert(cachedList[0].totalChunks > 0, 'Document summary has totalChunks')
  console.log('✓ Passed: IndexedDB document and chunks atomic persistence')

  // Step 4: Retrieve Cached Content & Verify Order
  const retrievedDoc1 = await getDocumentWithChunks(article1.url, db)
  assert(retrievedDoc1 !== null, 'Retrieved Article 1 from cache')
  assert(retrievedDoc1!.chunks.length === chunked1.totalChunks, 'All stored chunks retrieved')
  for (let i = 0; i < retrievedDoc1!.chunks.length; i++) {
    assert(retrievedDoc1!.chunks[i].chunkIndex === i, `Chunk ${i} preserved in ascending reading order`)
  }
  console.log('✓ Passed: Offline cached document & ordered chunks retrieval')

  // Step 5: Multi-document Keyword Search
  const searchResults1 = await searchCachedContent('transformers neural network', { dbInstance: db })
  assert(searchResults1.length > 0, 'Found results for neural network search')
  assert(searchResults1[0].documentId === article1.url, 'Ranked Article 1 first for NLP terms')
  assert(searchResults1[0].matchedTerms.includes('transformers'), 'Identified matched token')

  const searchResults2 = await searchCachedContent('cryptography superposition', { dbInstance: db })
  assert(searchResults2.length > 0, 'Found results for quantum terms')
  assert(searchResults2[0].documentId === article2.url, 'Ranked Article 2 first for quantum terms')
  console.log('✓ Passed: Multi-document local search and passage ranking')

  // Step 6: Document Update & Stale Chunks/Search Purge
  const updatedArticle1: ExtractedContent = {
    ...article1,
    textContent: 'Only modern algorithms are explored here without ancient neural methods.',
  }
  const updatedChunked1 = chunkContent(updatedArticle1)
  assert(updatedChunked1.totalChunks === 1, 'Updated article has only 1 chunk (reduced)')

  await saveDocumentAndChunks(updatedArticle1, updatedChunked1, db)

  const retrievedUpdated = await getDocumentWithChunks(article1.url, db)
  assert(retrievedUpdated!.chunks.length === 1, 'Only 1 chunk remains in DB; old chunks purged')

  // Old term "transformers" must no longer be found
  const searchOldTerm = await searchCachedContent('transformers', { dbInstance: db })
  assert(searchOldTerm.length === 0, 'Stale search results completely eliminated on update')
  console.log('✓ Passed: Document update eliminates stale chunks and search results')

  // Step 7: Delete Document & Confirm Elimination
  await deleteDocument(article2.url, db)
  const remainingList = await listCachedDocuments(db)
  assert(remainingList.length === 1, 'Only 1 document remains in cache after deletion')

  const searchDeleted = await searchCachedContent('superposition entanglement', { dbInstance: db })
  assert(searchDeleted.length === 0, 'Deleted document passages completely eliminated from search')
  console.log('✓ Passed: Document deletion eliminates all chunks and search results')

  // Step 8: Clear Whole Cache
  await clearAllCache(db)
  const emptyList = await listCachedDocuments(db)
  assert(emptyList.length === 0, 'Cache completely empty after clear')

  const searchEmpty = await searchCachedContent('algorithms', { dbInstance: db })
  assert(searchEmpty.length === 0, 'Search over cleared cache returns empty array without error')
  console.log('✓ Passed: Cache clear and graceful empty state')

  db.close()
  console.log('--- ALL END-TO-END INTEGRATION TESTS PASSED SUCCESSFULLY ---')
}

runIntegrationTests().catch((err) => {
  console.error('Integration test failed:', err)
  process.exit(1)
})
