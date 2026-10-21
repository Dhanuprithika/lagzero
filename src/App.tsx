import { useCallback, useEffect, useState } from 'react'
import type {
  CachedChunk,
  CachedDocument,
  CachedDocumentSummary,
  ChunkedDocument,
  ExtractedContent,
  ExtractPageContentResponse,
  GetActiveTabResponse,
  GetPageInfoResponse,
  PageMetadata,
  PingResponse,
  TabInfo,
} from './types/messaging'
import { chunkContent } from './utils/chunkContent'
import {
  checkDocumentCacheStatus,
  clearAllCache,
  deleteDocument,
  getDocumentWithChunks,
  listCachedDocuments,
  saveDocumentAndChunks,
} from './utils/storage'
import './App.css'

interface ConnectionState {
  status: 'idle' | 'checking' | 'connected' | 'error'
  backgroundPong: boolean
  activeTab?: TabInfo
  pageInfo?: PageMetadata
  errorMessage?: string
  lastTestedAt?: string
}

interface ExtractionState {
  status: 'idle' | 'extracting' | 'success' | 'error'
  content?: ExtractedContent
  errorMessage?: string
  extractedAt?: string
}

interface ChunkingState {
  status: 'idle' | 'chunking' | 'success' | 'error'
  chunkedDoc?: ChunkedDocument
  errorMessage?: string
  chunkedAt?: string
}

interface StorageState {
  status: 'idle' | 'saving' | 'saved' | 'loading' | 'error'
  isCurrentPageCached: boolean
  currentDocSummary?: CachedDocumentSummary
  cachedList: CachedDocumentSummary[]
  selectedDoc?: {
    document: CachedDocument
    chunks: CachedChunk[]
  }
  storageEstimate?: string
  errorMessage?: string
  lastActionAt?: string
}

export default function App() {
  const [connState, setConnState] = useState<ConnectionState>({
    status: 'idle',
    backgroundPong: false,
  })

  const [extractState, setExtractState] = useState<ExtractionState>({
    status: 'idle',
  })

  const [chunkState, setChunkState] = useState<ChunkingState>({
    status: 'idle',
  })

  const [storageState, setStorageState] = useState<StorageState>({
    status: 'idle',
    isCurrentPageCached: false,
    cachedList: [],
  })

  // Refreshes the list of cached documents and storage quota
  const refreshStorageData = useCallback(async (currentUrl?: string) => {
    try {
      const list = await listCachedDocuments()
      let isCached = false
      let summary: CachedDocumentSummary | undefined

      if (currentUrl) {
        const check = await checkDocumentCacheStatus(currentUrl)
        isCached = check.isCached
        summary = check.documentSummary
      }

      let storageEstimateText: string | undefined
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
        try {
          const estimate = await navigator.storage.estimate()
          if (typeof estimate.usage === 'number') {
            const kb = (estimate.usage / 1024).toFixed(1)
            storageEstimateText = `~${kb} KB used`
          }
        } catch {
          // Gracefully omit storage estimate if unsupported or restricted
        }
      }

      setStorageState((prev) => ({
        ...prev,
        cachedList: list,
        isCurrentPageCached: isCached,
        currentDocSummary: summary,
        storageEstimate: storageEstimateText,
      }))
    } catch (err) {
      console.warn('[LagZero Storage] Failed to refresh cached list:', err)
    }
  }, [])

  const testConnection = useCallback(async () => {
    // Retain previous activeTab during checking so UI does not flicker or blank out
    setConnState((prev) => ({
      ...prev,
      status: 'checking',
      errorMessage: undefined,
      pageInfo: undefined,
    }))

    try {
      // 1. Test Side Panel -> Background reachability via PING
      const pingResponse = await new Promise<PingResponse>((resolve) => {
        chrome.runtime.sendMessage({ type: 'PING' }, (res: PingResponse) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: chrome.runtime.lastError.message || 'Unable to reach the background service.',
              },
            })
          } else {
            resolve(res)
          }
        })
      })

      if (!pingResponse || !pingResponse.success) {
        setConnState({
          status: 'error',
          backgroundPong: false,
          errorMessage: pingResponse?.error?.message || 'Unable to reach the background service.',
          lastTestedAt: new Date().toLocaleTimeString(),
        })
        return
      }

      // 2. Query Active Tab from Background
      const tabResponse = await new Promise<GetActiveTabResponse>((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, (res: GetActiveTabResponse) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: chrome.runtime.lastError.message || 'Failed to detect active tab.',
              },
            })
          } else {
            resolve(res)
          }
        })
      })

      if (!tabResponse || !tabResponse.success) {
        setConnState({
          status: 'error',
          backgroundPong: true,
          errorMessage: tabResponse?.error?.message || 'No active tab available.',
          lastTestedAt: new Date().toLocaleTimeString(),
        })
        return
      }

      const activeTab = tabResponse.data

      // 3. Query Content Script Page Info through Background targeting detected tab ID
      const pageInfoResponse = await new Promise<GetPageInfoResponse>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'GET_PAGE_INFO', tabId: activeTab.id },
          (res: GetPageInfoResponse) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: {
                  code: 'INTERNAL_ERROR',
                  message: chrome.runtime.lastError.message || 'Communication with active tab failed.',
                },
              })
            } else {
              resolve(res)
            }
          }
        )
      })

      if (!pageInfoResponse || !pageInfoResponse.success) {
        setConnState({
          status: 'error',
          backgroundPong: true,
          activeTab,
          errorMessage: pageInfoResponse?.error?.message || 'Content script unavailable on this page.',
          lastTestedAt: new Date().toLocaleTimeString(),
        })
        return
      }

      setConnState({
        status: 'connected',
        backgroundPong: true,
        activeTab,
        pageInfo: pageInfoResponse.data,
        lastTestedAt: new Date().toLocaleTimeString(),
      })

      // Check cache status for active tab
      if (activeTab.url) {
        void refreshStorageData(activeTab.url)
      }
    } catch (err) {
      setConnState({
        status: 'error',
        backgroundPong: false,
        errorMessage: err instanceof Error ? err.message : 'Unexpected connection error.',
        lastTestedAt: new Date().toLocaleTimeString(),
      })
    }
  }, [refreshStorageData])

  const extractContent = useCallback(async () => {
    setExtractState({
      status: 'extracting',
      errorMessage: undefined,
    })
    setChunkState({
      status: 'idle',
    })

    try {
      // First ensure active tab is known
      let targetTabId = connState.activeTab?.id
      if (typeof targetTabId !== 'number') {
        const tabResponse = await new Promise<GetActiveTabResponse>((resolve) => {
          chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, (res: GetActiveTabResponse) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: {
                  code: 'INTERNAL_ERROR',
                  message: chrome.runtime.lastError.message || 'Failed to query active tab.',
                },
              })
            } else {
              resolve(res)
            }
          })
        })

        if (!tabResponse || !tabResponse.success) {
          setExtractState({
            status: 'error',
            errorMessage: tabResponse?.error?.message || 'Could not identify active tab for extraction.',
          })
          return
        }

        targetTabId = tabResponse.data.id
        setConnState((prev) => ({ ...prev, activeTab: tabResponse.data }))
      }

      const response = await new Promise<ExtractPageContentResponse>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'EXTRACT_PAGE_CONTENT', tabId: targetTabId },
          (res: ExtractPageContentResponse) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: {
                  code: 'INTERNAL_ERROR',
                  message: chrome.runtime.lastError.message || 'Extraction communication failed.',
                },
              })
            } else {
              resolve(res)
            }
          }
        )
      })

      if (!response || !response.success) {
        setExtractState({
          status: 'error',
          errorMessage: response?.error?.message || 'Failed to extract content from active page.',
          extractedAt: new Date().toLocaleTimeString(),
        })
        return
      }

      setExtractState({
        status: 'success',
        content: response.data,
        extractedAt: new Date().toLocaleTimeString(),
      })
    } catch (err) {
      setExtractState({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unexpected extraction failure.',
        extractedAt: new Date().toLocaleTimeString(),
      })
    }
  }, [connState.activeTab])

  const handleChunkContent = useCallback(() => {
    if (!extractState.content) {
      setChunkState({
        status: 'error',
        errorMessage: 'No extracted webpage content available to chunk. Please extract page content first.',
      })
      return
    }

    setChunkState({
      status: 'chunking',
    })

    try {
      const chunked = chunkContent(extractState.content)
      setChunkState({
        status: 'success',
        chunkedDoc: chunked,
        chunkedAt: new Date().toLocaleTimeString(),
      })
    } catch (err) {
      setChunkState({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'An error occurred during content chunking.',
        chunkedAt: new Date().toLocaleTimeString(),
      })
    }
  }, [extractState.content])

  // Save to IndexedDB Cache
  const handleSaveToCache = useCallback(async () => {
    if (!extractState.content || !chunkState.chunkedDoc) {
      setStorageState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: 'Both webpage content extraction and chunking are required before saving to local cache.',
      }))
      return
    }

    setStorageState((prev) => ({
      ...prev,
      status: 'saving',
      errorMessage: undefined,
    }))

    try {
      const savedDoc = await saveDocumentAndChunks(extractState.content, chunkState.chunkedDoc)
      await refreshStorageData(extractState.content.url)
      setStorageState((prev) => ({
        ...prev,
        status: 'saved',
        isCurrentPageCached: true,
        lastActionAt: new Date(savedDoc.updatedAt).toLocaleTimeString(),
      }))
    } catch (err) {
      setStorageState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to save document to IndexedDB.',
        lastActionAt: new Date().toLocaleTimeString(),
      }))
    }
  }, [extractState.content, chunkState.chunkedDoc, refreshStorageData])

  // View Cached Document Details
  const handleSelectCachedDoc = useCallback(async (docIdOrUrl: string) => {
    setStorageState((prev) => ({
      ...prev,
      status: 'loading',
      errorMessage: undefined,
    }))

    try {
      const result = await getDocumentWithChunks(docIdOrUrl)
      if (!result) {
        setStorageState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: 'Selected cached document was not found.',
        }))
        return
      }

      setStorageState((prev) => ({
        ...prev,
        status: 'idle',
        selectedDoc: result,
      }))
    } catch (err) {
      setStorageState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to retrieve cached document.',
      }))
    }
  }, [])

  // Delete Individual Cached Document
  const handleDeleteCachedDoc = useCallback(
    async (docIdOrUrl: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()

      try {
        await deleteDocument(docIdOrUrl)
        if (storageState.selectedDoc?.document.id === docIdOrUrl) {
          setStorageState((prev) => ({ ...prev, selectedDoc: undefined }))
        }
        await refreshStorageData(connState.activeTab?.url)
      } catch (err) {
        setStorageState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Failed to delete cached document.',
        }))
      }
    },
    [storageState.selectedDoc?.document.id, refreshStorageData, connState.activeTab?.url]
  )

  // Clear Entire Cache with Confirmation
  const handleClearCache = useCallback(async () => {
    const confirmClear = window.confirm(
      'Are you sure you want to clear all locally cached documents and chunks? This cannot be undone.'
    )
    if (!confirmClear) return

    try {
      await clearAllCache()
      setStorageState((prev) => ({
        ...prev,
        isCurrentPageCached: false,
        currentDocSummary: undefined,
        selectedDoc: undefined,
        cachedList: [],
        status: 'idle',
        lastActionAt: new Date().toLocaleTimeString(),
      }))
      await refreshStorageData(connState.activeTab?.url)
    } catch (err) {
      setStorageState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to clear local cache.',
      }))
    }
  }, [refreshStorageData, connState.activeTab?.url])

  // Auto-load storage list and check connection on side panel mount
  useEffect(() => {
    void refreshStorageData()
    const timer = setTimeout(() => {
      void testConnection()
    }, 0)
    return () => clearTimeout(timer)
  }, [testConnection, refreshStorageData])

  return (
    <div className="sidebar-container">
      {/* Header with branding and status */}
      <header className="sidebar-header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </span>
          <span className="brand-title">LagZero</span>
        </div>
        <div className="status-badge">
          <span
            className={`status-dot ${connState.status === 'connected' ? 'dot-active' : ''}`}
            aria-hidden="true"
          />
          <span>Local Content</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="sidebar-content">
        <section className="welcome-section">
          <h1 className="welcome-heading">How can I help?</h1>
          <p className="welcome-description">
            LagZero helps you understand and reuse webpage content, keeping workflows resilient even with slow or unreliable connections.
          </p>
        </section>

        {/* Milestone 2 Communication Test Card */}
        <section className="comm-test-card" aria-label="Extension Communication Status">
          <div className="comm-card-header">
            <span className="comm-card-title">Extension Communication</span>
            <button
              type="button"
              className="test-btn"
              onClick={testConnection}
              disabled={connState.status === 'checking'}
            >
              {connState.status === 'checking' ? 'Checking…' : 'Test Connection'}
            </button>
          </div>

          <div className="comm-status-list">
            {/* Step 1: Background Service Worker */}
            <div className="comm-status-row">
              <span className="row-label">Background Service:</span>
              <span
                className={`row-val ${
                  connState.backgroundPong
                    ? 'val-success'
                    : connState.status === 'checking'
                    ? 'val-checking'
                    : connState.status === 'error'
                    ? 'val-error'
                    : 'val-muted'
                }`}
              >
                {connState.status === 'checking'
                  ? 'Checking…'
                  : connState.backgroundPong
                  ? 'Connected'
                  : 'Disconnected'}
              </span>
            </div>

            {/* Step 2: Active Tab Detection */}
            <div className="comm-status-row">
              <span className="row-label">Active Tab:</span>
              <span
                className={`row-val ${
                  connState.activeTab
                    ? 'val-success'
                    : connState.status === 'checking'
                    ? 'val-checking'
                    : 'val-muted'
                }`}
              >
                {connState.status === 'checking'
                  ? 'Detecting…'
                  : connState.activeTab
                  ? 'Detected'
                  : 'None'}
              </span>
            </div>

            {/* Step 3: Content Script / Page Info */}
            <div className="comm-status-row">
              <span className="row-label">Page Information:</span>
              <span
                className={`row-val ${
                  connState.pageInfo
                    ? 'val-success'
                    : connState.status === 'checking'
                    ? 'val-checking'
                    : connState.status === 'error'
                    ? 'val-error'
                    : 'val-muted'
                }`}
              >
                {connState.status === 'checking'
                  ? 'Requesting…'
                  : connState.pageInfo
                  ? 'Received'
                  : 'Not available'}
              </span>
            </div>

            {/* Page details if successfully received */}
            {connState.pageInfo && (
              <div className="page-info-box">
                <div className="info-item">
                  <span className="info-key">Title:</span>{' '}
                  <span className="info-val">{connState.pageInfo.title || '(untitled page)'}</span>
                </div>
                <div className="info-item">
                  <span className="info-key">URL:</span>{' '}
                  <span className="info-val" title={connState.pageInfo.url}>
                    {connState.pageInfo.url}
                  </span>
                </div>
                <div className="info-item">
                  <span className="info-key">Ready State:</span>{' '}
                  <span className="info-val">{connState.pageInfo.readyState}</span>
                </div>
              </div>
            )}

            {/* Error feedback if failed */}
            {connState.status === 'error' && connState.errorMessage && (
              <div className="error-box" role="alert">
                <span className="error-text">{connState.errorMessage}</span>
              </div>
            )}

            {/* Timestamp feedback */}
            {connState.lastTestedAt && (
              <div className="comm-timestamp">
                <span>Last tested: {connState.lastTestedAt}</span>
              </div>
            )}
          </div>
        </section>

        {/* Milestone 3 Content Extraction Card */}
        <section className="extract-card" aria-label="Webpage Content Extraction">
          <div className="extract-card-header">
            <div>
              <span className="extract-card-title">Page Content Extraction</span>
              <span className="extract-card-sub">Extract readable article text</span>
            </div>
            <button
              type="button"
              className="extract-btn"
              onClick={extractContent}
              disabled={extractState.status === 'extracting'}
            >
              {extractState.status === 'extracting' ? 'Extracting…' : 'Extract Page Content'}
            </button>
          </div>

          <div className="extract-body">
            {extractState.status === 'extracting' && (
              <div className="extract-loading-box">
                <span className="loading-spinner" aria-hidden="true" />
                <span className="loading-text">Parsing readable content with Readability.js…</span>
              </div>
            )}

            {extractState.status === 'error' && extractState.errorMessage && (
              <div className="error-box" role="alert">
                <span className="error-text">{extractState.errorMessage}</span>
                {extractState.extractedAt && (
                  <div className="comm-timestamp">
                    <span>Attempted at: {extractState.extractedAt}</span>
                  </div>
                )}
              </div>
            )}

            {extractState.status === 'success' && extractState.content && (
              <div className="extract-result-box">
                {/* Article Header & Metadata */}
                <div className="extract-meta-header">
                  <h2 className="extract-title">
                    {extractState.content.title || '(Untitled Document)'}
                  </h2>
                  <div className="extract-source">
                    <span className="meta-label">Source:</span>{' '}
                    <span className="source-url" title={extractState.content.url}>
                      {extractState.content.url}
                    </span>
                  </div>

                  {/* Optional Metadata pills */}
                  <div className="extract-pills">
                    {extractState.content.siteName && (
                      <span className="meta-pill">
                        <strong>Site:</strong> {extractState.content.siteName}
                      </span>
                    )}
                    {extractState.content.byline && (
                      <span className="meta-pill">
                        <strong>Author:</strong> {extractState.content.byline}
                      </span>
                    )}
                    {extractState.content.publishedTime && (
                      <span className="meta-pill">
                        <strong>Date:</strong> {extractState.content.publishedTime}
                      </span>
                    )}
                    <span className="meta-pill">
                      <strong>Chars:</strong> {extractState.content.textContent.length.toLocaleString()}
                    </span>
                  </div>

                  {extractState.content.excerpt && (
                    <div className="extract-excerpt">
                      <em>&ldquo;{extractState.content.excerpt}&rdquo;</em>
                    </div>
                  )}

                  {extractState.content.isTruncated && (
                    <div className="truncation-notice">
                      Notice: Content was truncated at 100,000 characters from an original length of{' '}
                      {extractState.content.originalLength.toLocaleString()} characters.
                    </div>
                  )}
                </div>

                {/* Scrollable Clean Text Preview */}
                <div className="extract-text-preview" tabIndex={0} aria-label="Extracted readable text">
                  <pre className="readable-text">{extractState.content.textContent}</pre>
                </div>

                {extractState.extractedAt && (
                  <div className="comm-timestamp">
                    <span>Extracted at: {extractState.extractedAt}</span>
                  </div>
                )}
              </div>
            )}

            {extractState.status === 'idle' && (
              <div className="extract-idle-hint">
                <span>Click &ldquo;Extract Page Content&rdquo; to parse the active tab&apos;s main article text.</span>
              </div>
            )}
          </div>
        </section>

        {/* Milestone 4 Content Chunking Card */}
        <section className="chunk-card" aria-label="Content Chunking">
          <div className="chunk-card-header">
            <div>
              <span className="chunk-card-title">Content Chunking</span>
              <span className="chunk-card-sub">Paragraph-aware segmentation</span>
            </div>
            <button
              type="button"
              className="chunk-btn"
              onClick={handleChunkContent}
              disabled={!extractState.content || chunkState.status === 'chunking'}
            >
              {chunkState.status === 'chunking' ? 'Chunking…' : 'Chunk Content'}
            </button>
          </div>

          <div className="chunk-body">
            {!extractState.content && chunkState.status === 'idle' && (
              <div className="chunk-idle-hint">
                <span>Extract webpage content first to generate chunk segments.</span>
              </div>
            )}

            {extractState.content && chunkState.status === 'idle' && (
              <div className="chunk-ready-hint">
                <span>
                  Extracted content ready ({extractState.content.textContent.length.toLocaleString()} chars).
                  Click &ldquo;Chunk Content&rdquo; to create sequential chunks.
                </span>
              </div>
            )}

            {chunkState.status === 'chunking' && (
              <div className="chunk-loading-box">
                <span className="loading-spinner" aria-hidden="true" />
                <span className="loading-text">Chunking text by paragraph and size boundaries…</span>
              </div>
            )}

            {chunkState.status === 'error' && chunkState.errorMessage && (
              <div className="error-box" role="alert">
                <span className="error-text">{chunkState.errorMessage}</span>
                {chunkState.chunkedAt && (
                  <div className="comm-timestamp">
                    <span>Attempted at: {chunkState.chunkedAt}</span>
                  </div>
                )}
              </div>
            )}

            {chunkState.status === 'success' && chunkState.chunkedDoc && (
              <div className="chunk-result-box">
                {/* Chunk Summary Header */}
                <div className="chunk-summary-header">
                  <div className="chunk-pills">
                    <span className="meta-pill">
                      <strong>Total Chunks:</strong> {chunkState.chunkedDoc.totalChunks}
                    </span>
                    <span className="meta-pill">
                      <strong>Chunked Chars:</strong> {chunkState.chunkedDoc.totalCharacters.toLocaleString()}
                    </span>
                    <span className="meta-pill">
                      <strong>Target:</strong> ~1,000 chars
                    </span>
                    <span className="meta-pill">
                      <strong>Max:</strong> 1,500 chars
                    </span>
                  </div>
                </div>

                {/* Chunk Preview List (first 5 chunks previewed to prevent heavy DOM rendering) */}
                <div className="chunk-list" aria-label="Chunk previews">
                  {chunkState.chunkedDoc.chunks.slice(0, 5).map((chunk) => (
                    <article key={chunk.id} className="chunk-item">
                      <div className="chunk-item-header">
                        <span className="chunk-item-badge">Chunk #{chunk.index + 1}</span>
                        <span className="chunk-item-len">{chunk.characterCount.toLocaleString()} chars</span>
                      </div>

                      {chunk.headingContext && (
                        <div className="chunk-item-section">
                          <span className="section-label">Section:</span>{' '}
                          <span className="section-title">{chunk.headingContext}</span>
                        </div>
                      )}

                      <div className="chunk-item-text" tabIndex={0} aria-label={`Chunk ${chunk.index + 1} text`}>
                        <p className="chunk-text-content">{chunk.text}</p>
                      </div>
                    </article>
                  ))}

                  {chunkState.chunkedDoc.totalChunks > 5 && (
                    <div className="chunk-overflow-notice">
                      Showing first 5 of {chunkState.chunkedDoc.totalChunks} chunks in preview. All chunks are structured in memory.
                    </div>
                  )}
                </div>

                {chunkState.chunkedAt && (
                  <div className="comm-timestamp">
                    <span>Chunked at: {chunkState.chunkedAt}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Milestone 5 Local Content Cache Card */}
        <section className="cache-card" aria-label="Local Content Cache">
          <div className="cache-card-header">
            <div>
              <span className="cache-card-title">Local Content Cache</span>
              <span className="cache-card-sub">Native IndexedDB persistence</span>
            </div>
            <button
              type="button"
              className="cache-btn primary"
              onClick={handleSaveToCache}
              disabled={!extractState.content || !chunkState.chunkedDoc || storageState.status === 'saving'}
            >
              {storageState.status === 'saving'
                ? 'Saving…'
                : storageState.isCurrentPageCached
                ? 'Update in Cache'
                : 'Save to Local Cache'}
            </button>
          </div>

          <div className="cache-body">
            {/* Cache Status Bar */}
            <div className="cache-status-bar">
              <div className="cache-status-badges">
                <span className={`status-pill ${storageState.isCurrentPageCached ? 'cached' : 'not-cached'}`}>
                  {storageState.isCurrentPageCached ? 'Current Page: Cached' : 'Current Page: Not Cached'}
                </span>
                <span className="meta-pill">
                  <strong>Saved Docs:</strong> {storageState.cachedList.length}
                </span>
                {storageState.storageEstimate && (
                  <span className="meta-pill">
                    <strong>Storage:</strong> {storageState.storageEstimate}
                  </span>
                )}
              </div>
              {storageState.cachedList.length > 0 && (
                <button
                  type="button"
                  className="cache-clear-btn"
                  onClick={handleClearCache}
                  title="Clear all cached documents and chunks"
                >
                  Clear Cache
                </button>
              )}
            </div>

            {/* Save disabled hint */}
            {(!extractState.content || !chunkState.chunkedDoc) && (
              <div className="cache-hint-box">
                <span>
                  {!extractState.content
                    ? 'Extract and chunk webpage content to enable local caching.'
                    : 'Chunk extracted content to enable local caching.'}
                </span>
              </div>
            )}

            {/* Storage Operation Status or Error */}
            {storageState.status === 'error' && storageState.errorMessage && (
              <div className="error-box" role="alert">
                <span className="error-text">{storageState.errorMessage}</span>
                {storageState.lastActionAt && (
                  <div className="comm-timestamp">
                    <span>At: {storageState.lastActionAt}</span>
                  </div>
                )}
              </div>
            )}

            {storageState.status === 'saved' && (
              <div className="cache-success-box" role="status">
                <span className="success-text">Document and chunks successfully stored in IndexedDB.</span>
                {storageState.lastActionAt && (
                  <div className="comm-timestamp">
                    <span>Saved at: {storageState.lastActionAt}</span>
                  </div>
                )}
              </div>
            )}

            {/* Cached Documents List */}
            <div className="cached-docs-section">
              <span className="section-subtitle">Saved Documents</span>
              {storageState.cachedList.length === 0 ? (
                <div className="cache-empty-box">
                  <span>No documents saved in local cache yet.</span>
                </div>
              ) : (
                <div className="cached-docs-list" aria-label="Saved documents list">
                  {storageState.cachedList.map((doc) => {
                    const isSelected = storageState.selectedDoc?.document.id === doc.id
                    return (
                      <div
                        key={doc.id}
                        className={`cached-doc-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectCachedDoc(doc.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            handleSelectCachedDoc(doc.id)
                          }
                        }}
                        aria-label={`Select cached document ${doc.title}`}
                      >
                        <div className="cached-doc-info">
                          <div className="cached-doc-title-row">
                            <span className="cached-doc-title" title={doc.title}>
                              {doc.title || 'Untitled Document'}
                            </span>
                            <button
                              type="button"
                              className="cached-doc-delete-btn"
                              onClick={(e) => handleDeleteCachedDoc(doc.id, e)}
                              title="Delete from cache"
                              aria-label={`Delete ${doc.title} from cache`}
                            >
                              &times;
                            </button>
                          </div>
                          <div className="cached-doc-meta-row">
                            <span className="cached-doc-meta">{doc.totalChunks} chunks</span>
                            <span className="cached-doc-meta">&bull;</span>
                            <span className="cached-doc-meta">{doc.totalCharacters.toLocaleString()} chars</span>
                            <span className="cached-doc-meta">&bull;</span>
                            <span className="cached-doc-meta">
                              {new Date(doc.updatedAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="cached-doc-url" title={doc.sourceUrl}>
                            {doc.sourceUrl}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Selected Cached Document Detail View */}
            {storageState.selectedDoc && (
              <div className="selected-cache-detail" aria-label="Selected cached document detail">
                <div className="selected-cache-header">
                  <div className="selected-cache-title-wrap">
                    <span className="selected-cache-badge">Retrieved From Local Cache (Offline)</span>
                    <h3 className="selected-cache-title">{storageState.selectedDoc.document.title}</h3>
                    <div className="selected-cache-url">{storageState.selectedDoc.document.sourceUrl}</div>
                  </div>
                  <button
                    type="button"
                    className="selected-cache-close-btn"
                    onClick={() => setStorageState((prev) => ({ ...prev, selectedDoc: undefined }))}
                    title="Close detail view"
                  >
                    Close
                  </button>
                </div>

                <div className="selected-cache-stats">
                  <span className="meta-pill">
                    <strong>Chunks:</strong> {storageState.selectedDoc.document.totalChunks}
                  </span>
                  <span className="meta-pill">
                    <strong>Characters:</strong> {storageState.selectedDoc.document.totalCharacters.toLocaleString()}
                  </span>
                  <span className="meta-pill">
                    <strong>Saved:</strong> {new Date(storageState.selectedDoc.document.updatedAt).toLocaleTimeString()}
                  </span>
                </div>

                {/* Chunks in ascending order */}
                <div className="selected-cache-chunks" aria-label="Cached chunks ordered">
                  <span className="chunks-list-heading">Stored Chunks (Ordered)</span>
                  {storageState.selectedDoc.chunks.map((chunk) => (
                    <article key={chunk.id} className="chunk-item cached-chunk-item">
                      <div className="chunk-item-header">
                        <span className="chunk-item-badge">Chunk #{chunk.chunkIndex + 1}</span>
                        <span className="chunk-item-len">{chunk.characterCount.toLocaleString()} chars</span>
                      </div>
                      {chunk.headingContext && (
                        <div className="chunk-item-section">
                          <span className="section-label">Section:</span>{' '}
                          <span className="section-title">{chunk.headingContext}</span>
                        </div>
                      )}
                      <div className="chunk-item-text" tabIndex={0}>
                        <p className="chunk-text-content">{chunk.text}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Existing Phase 1 Placeholder */}
        <section className="input-section">
          <div className="input-wrapper">
            <input
              type="text"
              disabled
              placeholder="Phase 1 development in progress"
              aria-label="Phase 1 development in progress"
              className="placeholder-input"
            />
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="sidebar-footer">
        <span className="footer-text">Local-first browser assistant</span>
      </footer>
    </div>
  )
}
