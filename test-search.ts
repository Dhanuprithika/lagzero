import 'fake-indexeddb/auto'
import {
  normalizeQuery,
  searchCachedContent,
  searchUnifiedContent,
} from './src/utils/search'
import {
  clearAllCache,
  deleteDocument,
  openLagZeroDB,
  saveDocumentAndChunks,
} from './src/utils/storage'
import type { ChunkedDocument, ExtractedContent } from './src/types/messaging'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

async function runSearchTests() {
  console.log('--- Running Local Keyword Search Unit Tests ---')

  const db = await openLagZeroDB()
  await clearAllCache(db)

  // Test 1: Query Normalization
  {
    const res1 = normalizeQuery('  ')
    assert(res1.tokens.length === 0, 'Empty/whitespace returns empty tokens')

    const res2 = normalizeQuery('  Machine Learning & Artificial-Intelligence!!  ')
    assert(res2.normalizedQuery === 'machine learning & artificial-intelligence!!', 'Normalized string trimmed and lowercased')
    assert(
      res2.tokens.includes('machine') &&
      res2.tokens.includes('learning') &&
      res2.tokens.includes('artificial') &&
      res2.tokens.includes('intelligence'),
      'Tokens properly extracted'
    )
    console.log('✓ Passed: Query Normalization')
  }

  // Test 2: Empty query returns empty results
  {
    const results = await searchCachedContent('', { dbInstance: db })
    assert(results.length === 0, 'Empty query returns empty array')

    const whitespaceResults = await searchCachedContent('   \n  \t ', { dbInstance: db })
    assert(whitespaceResults.length === 0, 'Whitespace query returns empty array')
    console.log('✓ Passed: Empty and whitespace queries')
  }

  // Test 3: Empty cache behavior
  {
    const results = await searchCachedContent('neural networks', { dbInstance: db })
    assert(results.length === 0, 'Searching empty cache returns empty array')
    console.log('✓ Passed: Empty cache search')
  }

  // Populate test documents in IndexedDB
  const doc1Extracted: ExtractedContent = {
    title: 'Artificial Intelligence and Neural Networks',
    byline: 'John McCarthy',
    dir: 'ltr',
    content: '<p>Artificial intelligence is intelligence demonstrated by machines.</p>',
    textContent: 'Artificial intelligence is intelligence demonstrated by machines. Neural networks are biologically inspired.',
    length: 110,
    excerpt: 'AI overview',
    siteName: 'AI Wiki',
    publishedTime: null,
    url: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
    isTruncated: false,
    originalLength: 110,
  }

  const doc1Chunked: ChunkedDocument = {
    documentId: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
    totalChunks: 2,
    totalCharacters: 110,
    chunks: [
      {
        id: 'https://en.wikipedia.org/wiki/Artificial_intelligence::0',
        index: 0,
        text: 'Artificial intelligence is intelligence demonstrated by machines. It synthesizes tasks normally requiring human intelligence.',
        characterCount: 125,
        headingContext: 'Introduction',
        documentTitle: doc1Extracted.title,
        sourceUrl: doc1Extracted.url,
        extractedAt: Date.now(),
      },
      {
        id: 'https://en.wikipedia.org/wiki/Artificial_intelligence::1',
        index: 1,
        text: 'Neural networks and deep learning are core approaches in modern computational models.',
        characterCount: 85,
        headingContext: 'Machine Learning Subfields',
        documentTitle: doc1Extracted.title,
        sourceUrl: doc1Extracted.url,
        extractedAt: Date.now(),
      },
    ],
  }

  const doc2Extracted: ExtractedContent = {
    title: 'History of Computing Hardware',
    byline: 'Ada Lovelace',
    dir: 'ltr',
    content: '<p>Early computing devices included the abacus and mechanical calculators.</p>',
    textContent: 'Early computing devices included the abacus and mechanical calculators.',
    length: 72,
    excerpt: 'Computing history',
    siteName: 'History Net',
    publishedTime: null,
    url: 'https://example.org/history/computing',
    isTruncated: false,
    originalLength: 72,
  }

  const doc2Chunked: ChunkedDocument = {
    documentId: 'https://example.org/history/computing',
    totalChunks: 1,
    totalCharacters: 72,
    chunks: [
      {
        id: 'https://example.org/history/computing::0',
        index: 0,
        text: 'Early computing devices included the abacus and mechanical calculators designed by pioneers.',
        characterCount: 92,
        headingContext: 'Early Calculating Devices',
        documentTitle: doc2Extracted.title,
        sourceUrl: doc2Extracted.url,
        extractedAt: Date.now(),
      },
    ],
  }

  await saveDocumentAndChunks(doc1Extracted, doc1Chunked, db)
  await saveDocumentAndChunks(doc2Extracted, doc2Chunked, db)

  // Test 4: Case-insensitive search across documents
  {
    const results = await searchCachedContent('ARTIFICIAL INTELLIGENCE', { dbInstance: db })
    assert(results.length > 0, 'Found results for uppercase query')
    assert(results[0].documentTitle === 'Artificial Intelligence and Neural Networks', 'Matched correct document')
    assert(results[0].sourceUrl === 'https://en.wikipedia.org/wiki/Artificial_intelligence', 'Matched correct source URL')
    console.log('✓ Passed: Case-insensitive matching')
  }

  // Test 5: Exact phrase match ranking boost
  {
    // Chunk #0 has exact phrase "artificial intelligence"
    // Chunk #1 has words "neural networks"
    const results = await searchCachedContent('artificial intelligence', { dbInstance: db })
    assert(results.length > 0, 'Returned results')
    assert(results[0].chunkIndex === 0, 'Chunk #0 with exact phrase ranks #1')
    assert(results[0].exactPhraseMatch === true, 'Flagged exactPhraseMatch')
    console.log('✓ Passed: Exact phrase ranking boost')
  }

  // Test 6: Document title boosting
  {
    // Query "Hardware" is in doc2's title
    const results = await searchCachedContent('hardware', { dbInstance: db })
    assert(results.length === 1, 'Found doc2')
    assert(results[0].documentId === 'https://example.org/history/computing', 'Doc2 matched on title')
    assert(results[0].titleMatch === true, 'Title match flag true')
    console.log('✓ Passed: Title match boosting')
  }

  // Test 7: Multi-word query matching and query coverage
  {
    const results = await searchCachedContent('deep learning models', { dbInstance: db })
    assert(results.length >= 1, 'Found matching chunk')
    assert(results[0].chunkIndex === 1, 'Chunk #1 with deep learning models matched')
    assert(results[0].matchedTerms.includes('deep'), 'Matched token deep')
    assert(results[0].matchedTerms.includes('learning'), 'Matched token learning')
    assert(results[0].matchedTerms.includes('models'), 'Matched token models')
    console.log('✓ Passed: Multi-word query matching')
  }

  // Test 8: Result limit parameter
  {
    const allResults = await searchCachedContent('the', { dbInstance: db, limit: 1 })
    assert(allResults.length <= 1, 'Result limit honored')
    console.log('✓ Passed: Result limit parameter')
  }

  // Test 9: No results behavior for non-existent terms
  {
    const results = await searchCachedContent('quantum entanglement teleportation', { dbInstance: db })
    assert(results.length === 0, 'No results returned for unmatched query')
    console.log('✓ Passed: No results behavior')
  }

  // Test 10: Updated chunks reflected in search
  {
    const updatedDoc1Extracted: ExtractedContent = {
      ...doc1Extracted,
      textContent: 'Quantum computing is a new paradigm.',
    }
    const updatedDoc1Chunked: ChunkedDocument = {
      documentId: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
      totalChunks: 1,
      totalCharacters: 40,
      chunks: [
        {
          id: 'https://en.wikipedia.org/wiki/Artificial_intelligence::0',
          index: 0,
          text: 'Quantum computing is a new paradigm replacing classical models.',
          characterCount: 65,
          headingContext: 'Quantum Physics',
          documentTitle: 'Artificial Intelligence and Neural Networks',
          sourceUrl: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
          extractedAt: Date.now(),
        },
      ],
    }

    await saveDocumentAndChunks(updatedDoc1Extracted, updatedDoc1Chunked, db)

    // Now searching for "quantum" should find updated doc1
    const results = await searchCachedContent('quantum', { dbInstance: db })
    assert(results.length === 1, 'Updated chunk found with new term')
    assert(results[0].passageText.includes('Quantum computing'), 'Updated passage returned')

    // Old term "biologically" in old chunk 1 should NO LONGER be found (neither in text nor title)
    const oldResults = await searchCachedContent('biologically', { dbInstance: db })
    assert(oldResults.length === 0, 'Old purged chunk terms no longer match')
    console.log('✓ Passed: Updated chunks reflected & stale chunks absent')
  }

  // Test 11: Deleted document chunks do not appear in results
  {
    await deleteDocument('https://example.org/history/computing', db)
    const results = await searchCachedContent('abacus calculators', { dbInstance: db })
    assert(results.length === 0, 'Deleted document chunks do not appear in search')
    console.log('✓ Passed: Deleted document chunks removed from search')
  }

  // Test 12: Unified Search searches unsaved active tab content without persisting it
  {
    const unsavedContent: ExtractedContent = {
      title: 'Breaking Technology News Today',
      url: 'https://news.example.com/breaking-ai',
      textContent: 'Generative robotics is transforming manufacturing plants across Europe.',
      excerpt: 'Robotics news',
      byline: 'Tech Reporter',
      siteName: 'Tech Today',
      publishedTime: null,
      extractedAt: Date.now(),
      isTruncated: false,
      originalLength: 72,
    }

    const unifiedResults = await searchUnifiedContent('robotics manufacturing', {
      dbInstance: db,
      currentTabUrl: unsavedContent.url,
      currentContent: unsavedContent,
    })

    assert(unifiedResults.length > 0, 'Unsaved active tab content is found')
    assert(unifiedResults[0].isCurrentPage === true, 'Marked as isCurrentPage: true')
    assert(unifiedResults[0].passageText.includes('Generative robotics'), 'Matched passage text returned')

    // Confirm it was NOT persisted to IndexedDB
    const savedAfter = await searchCachedContent('robotics', { dbInstance: db })
    assert(savedAfter.length === 0, 'Temporary active page was NOT persisted to IndexedDB')
    console.log('✓ Passed: Unified Search searches unsaved current page without persistence')
  }

  // Test 13: Unified Search deduplicates when active tab is already saved
  {
    const alreadySavedUrl = 'https://en.wikipedia.org/wiki/Artificial_intelligence'
    const duplicateContent: ExtractedContent = {
      title: 'Artificial Intelligence and Neural Networks',
      url: alreadySavedUrl,
      textContent: 'Quantum computing is a new paradigm replacing classical models.',
      excerpt: null,
      byline: null,
      siteName: null,
      publishedTime: null,
      extractedAt: Date.now(),
      isTruncated: false,
      originalLength: 65,
    }

    const results = await searchUnifiedContent('quantum computing', {
      dbInstance: db,
      currentTabUrl: alreadySavedUrl,
      currentContent: duplicateContent,
    })

    // Should only have 1 result, not duplicates
    const matchingCount = results.filter((r) => r.sourceUrl === alreadySavedUrl).length
    assert(matchingCount === 1, 'No duplicate passages returned for already saved active page')
    assert(results[0].isCurrentPage === true, 'Saved page matching active tab marked with isCurrentPage: true')
    console.log('✓ Passed: Unified Search deduplicates when active page is already saved')
  }

  // Clean up
  await clearAllCache(db)
  db.close()

  console.log('--- ALL KEYWORD SEARCH TESTS PASSED SUCCESSFULLY ---')
}

runSearchTests().catch((err) => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
