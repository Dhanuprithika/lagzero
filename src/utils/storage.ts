import type {
  CachedChunk,
  CachedDocument,
  CachedDocumentSummary,
  ChunkedDocument,
  ExtractedContent,
} from '../types/messaging'

const DB_NAME = 'lagzero_local_db'
const DB_VERSION = 1

export const STORE_DOCUMENTS = 'documents'
export const STORE_CHUNKS = 'chunks'
export const INDEX_CHUNKS_BY_DOC_ID = 'by_documentId'

/**
 * Normalizes a URL for a stable document identifier.
 * Policy:
 * 1. Strips URL fragments (#section) because fragments refer to locations within the same page.
 * 2. Retains query parameters (?query=...) because query parameters frequently distinguish
 *    different pages/articles (e.g. ?id=123, ?article=xyz).
 * 3. Strips trailing slashes from pathnames to unify 'https://example.com/page/' and 'https://example.com/page'.
 * 4. Lowercases the hostname.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = '' // Remove fragment
    let pathname = url.pathname
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1)
    }
    url.pathname = pathname
    url.hostname = url.hostname.toLowerCase()
    return url.toString()
  } catch {
    // If not a valid URL (e.g. malformed or about:blank), return trimmed rawUrl
    return rawUrl.trim()
  }
}

/**
 * Opens or upgrades the LagZero IndexedDB database.
 */
export function openLagZeroDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // 1. Documents store (keyed by stable document ID)
      if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        const docStore = db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' })
        docStore.createIndex('by_updatedAt', 'updatedAt', { unique: false })
        docStore.createIndex('by_sourceUrl', 'sourceUrl', { unique: false })
      }

      // 2. Chunks store (keyed by composite ID: `${documentId}::${chunkIndex}`)
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' })
        chunkStore.createIndex(INDEX_CHUNKS_BY_DOC_ID, 'documentId', { unique: false })
        chunkStore.createIndex('by_doc_and_index', ['documentId', 'chunkIndex'], { unique: true })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message || 'Unknown error'}`))
    }
  })
}

/**
 * Saves or updates an extracted document and its chunks in an atomic IndexedDB transaction.
 * If the document already exists:
 * - Its metadata and text are updated.
 * - Any previous chunks for this document are deleted before inserting the new chunks,
 *   guaranteeing no duplicate or stale chunks remain.
 */
export async function saveDocumentAndChunks(
  extracted: ExtractedContent,
  chunked: ChunkedDocument,
  dbInstance?: IDBDatabase
): Promise<CachedDocument> {
  const db = dbInstance ?? (await openLagZeroDB())
  const docId = normalizeUrl(extracted.url)
  const now = Date.now()

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCUMENTS, STORE_CHUNKS], 'readwrite')
    const docStore = tx.objectStore(STORE_DOCUMENTS)
    const chunkStore = tx.objectStore(STORE_CHUNKS)
    const chunksByDoc = chunkStore.index(INDEX_CHUNKS_BY_DOC_ID)

    let finalDocument: CachedDocument

    tx.onabort = () => {
      reject(new Error(`Transaction aborted: ${tx.error?.message || 'Unknown transaction failure'}`))
    }

    tx.onerror = () => {
      reject(new Error(`Transaction error: ${tx.error?.message || 'Storage error'}`))
    }

    tx.oncomplete = () => {
      resolve(finalDocument)
    }

    // Step 1: Check if document previously exists to preserve original cachedAt
    const getDocReq = docStore.get(docId)

    getDocReq.onsuccess = () => {
      const existing = getDocReq.result as CachedDocument | undefined
      const cachedAt = existing ? existing.cachedAt : now

      finalDocument = {
        id: docId,
        title: extracted.title,
        sourceUrl: extracted.url,
        extractedText: extracted.textContent,
        excerpt: extracted.excerpt,
        byline: extracted.byline,
        siteName: extracted.siteName,
        publishedTime: extracted.publishedTime,
        extractedAt: extracted.extractedAt,
        cachedAt,
        updatedAt: now,
        totalChunks: chunked.chunks.length,
        totalCharacters: chunked.totalCharacters,
        schemaVersion: 1,
      }

      // Step 2: Delete all existing chunks for this document ID to prevent orphans
      const delReq = chunksByDoc.openCursor(IDBKeyRange.only(docId))
      delReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          // All existing chunks deleted, now insert new document and chunks
          docStore.put(finalDocument)

          for (const chunk of chunked.chunks) {
            const cachedChunk: CachedChunk = {
              id: `${docId}::${chunk.index}`,
              documentId: docId,
              chunkIndex: chunk.index,
              text: chunk.text,
              characterCount: chunk.characterCount,
              headingContext: chunk.headingContext,
              documentTitle: chunk.documentTitle,
              sourceUrl: chunk.sourceUrl,
              extractedAt: chunk.extractedAt,
            }
            chunkStore.put(cachedChunk)
          }
        }
      }
    }
  })
}

/**
 * Retrieves a cached document and all its chunks sorted in ascending sequence order.
 */
export async function getDocumentWithChunks(
  rawUrl: string,
  dbInstance?: IDBDatabase
): Promise<{ document: CachedDocument; chunks: CachedChunk[] } | null> {
  const db = dbInstance ?? (await openLagZeroDB())
  const docId = normalizeUrl(rawUrl)

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCUMENTS, STORE_CHUNKS], 'readonly')
    const docStore = tx.objectStore(STORE_DOCUMENTS)
    const chunkStore = tx.objectStore(STORE_CHUNKS)
    const chunksByDoc = chunkStore.index(INDEX_CHUNKS_BY_DOC_ID)

    let doc: CachedDocument | undefined
    const chunks: CachedChunk[] = []

    tx.onerror = () => {
      reject(new Error(`Failed to retrieve document: ${tx.error?.message || 'Storage error'}`))
    }

    const docReq = docStore.get(docId)
    docReq.onsuccess = () => {
      doc = docReq.result as CachedDocument | undefined
      if (!doc) {
        // Document does not exist
        return
      }

      const chunkReq = chunksByDoc.openCursor(IDBKeyRange.only(docId))
      chunkReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          chunks.push(cursor.value as CachedChunk)
          cursor.continue()
        }
      }
    }

    tx.oncomplete = () => {
      if (!doc) {
        resolve(null)
      } else {
        // Sort ascending by chunkIndex
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)
        resolve({ document: doc, chunks })
      }
    }
  })
}

/**
 * Lists all cached documents as lightweight metadata summaries, sorted by most recently updated first.
 */
export async function listCachedDocuments(
  dbInstance?: IDBDatabase
): Promise<CachedDocumentSummary[]> {
  const db = dbInstance ?? (await openLagZeroDB())

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, 'readonly')
    const store = tx.objectStore(STORE_DOCUMENTS)
    const summaries: CachedDocumentSummary[] = []

    tx.onerror = () => {
      reject(new Error(`Failed to list documents: ${tx.error?.message || 'Storage error'}`))
    }

    const req = store.openCursor()
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
      if (cursor) {
        const doc = cursor.value as CachedDocument
        summaries.push({
          id: doc.id,
          title: doc.title,
          sourceUrl: doc.sourceUrl,
          cachedAt: doc.cachedAt,
          updatedAt: doc.updatedAt,
          totalChunks: doc.totalChunks,
          totalCharacters: doc.totalCharacters,
        })
        cursor.continue()
      } else {
        // Sort by updatedAt descending (newest first)
        summaries.sort((a, b) => b.updatedAt - a.updatedAt)
        resolve(summaries)
      }
    }
  })
}

/**
 * Deletes a cached document and all its chunks atomically.
 */
export async function deleteDocument(
  rawUrlOrId: string,
  dbInstance?: IDBDatabase
): Promise<boolean> {
  const db = dbInstance ?? (await openLagZeroDB())
  const docId = rawUrlOrId.startsWith('http') ? normalizeUrl(rawUrlOrId) : rawUrlOrId

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCUMENTS, STORE_CHUNKS], 'readwrite')
    const docStore = tx.objectStore(STORE_DOCUMENTS)
    const chunkStore = tx.objectStore(STORE_CHUNKS)
    const chunksByDoc = chunkStore.index(INDEX_CHUNKS_BY_DOC_ID)

    let found = false

    tx.onerror = () => {
      reject(new Error(`Failed to delete document: ${tx.error?.message || 'Storage error'}`))
    }

    tx.oncomplete = () => {
      resolve(found)
    }

    const checkReq = docStore.get(docId)
    checkReq.onsuccess = () => {
      if (!checkReq.result) {
        found = false
        return
      }
      found = true
      docStore.delete(docId)

      const chunkReq = chunksByDoc.openCursor(IDBKeyRange.only(docId))
      chunkReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }
    }
  })
}

/**
 * Clears all cached documents and chunks without modifying any other extension data.
 */
export async function clearAllCache(dbInstance?: IDBDatabase): Promise<void> {
  const db = dbInstance ?? (await openLagZeroDB())

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCUMENTS, STORE_CHUNKS], 'readwrite')
    const docStore = tx.objectStore(STORE_DOCUMENTS)
    const chunkStore = tx.objectStore(STORE_CHUNKS)

    tx.onerror = () => {
      reject(new Error(`Failed to clear cache: ${tx.error?.message || 'Storage error'}`))
    }

    tx.oncomplete = () => {
      resolve()
    }

    docStore.clear()
    chunkStore.clear()
  })
}

/**
 * Checks whether a document with the given URL is already cached.
 */
export async function checkDocumentCacheStatus(
  rawUrl: string,
  dbInstance?: IDBDatabase
): Promise<{ isCached: boolean; documentSummary?: CachedDocumentSummary }> {
  const db = dbInstance ?? (await openLagZeroDB())
  const docId = normalizeUrl(rawUrl)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, 'readonly')
    const store = tx.objectStore(STORE_DOCUMENTS)

    tx.onerror = () => {
      reject(new Error(`Failed to check cache status: ${tx.error?.message || 'Storage error'}`))
    }

    const req = store.get(docId)
    req.onsuccess = () => {
      const doc = req.result as CachedDocument | undefined
      if (doc) {
        resolve({
          isCached: true,
          documentSummary: {
            id: doc.id,
            title: doc.title,
            sourceUrl: doc.sourceUrl,
            cachedAt: doc.cachedAt,
            updatedAt: doc.updatedAt,
            totalChunks: doc.totalChunks,
            totalCharacters: doc.totalCharacters,
          },
        })
      } else {
        resolve({ isCached: false })
      }
    }
  })
}
