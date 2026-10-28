import { useCallback, useEffect, useRef, useState } from 'react'
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
  SearchResult,
  TabInfo,
} from './types/messaging'
import { chunkContent } from './utils/chunkContent'
import { searchUnifiedContent } from './utils/search'
import {
  checkDocumentCacheStatus,
  clearAllCache,
  getDocumentWithChunks,
  listCachedDocuments,
  saveDocumentAndChunks,
} from './utils/storage'
import './App.css'

/**
 * Safely renders text with matched search terms highlighted, without raw HTML injection.
 */
function renderHighlightedText(text: string, matchedTerms: string[]) {
  if (!matchedTerms.length || !text) {
    return text
  }

  // Escape special regex characters in terms
  const escapedTerms = matchedTerms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  if (!escapedTerms.length) {
    return text
  }

  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi')
  const parts = text.split(regex)

  return parts.map((part, i) => {
    const isMatch = escapedTerms.some((t) => new RegExp(`^${t}$`, 'i').test(part))
    return isMatch ? (
      <mark key={i} className="search-highlight">
        {part}
      </mark>
    ) : (
      part
    )
  })
}

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

interface SearchState {
  query: string
  status: 'idle' | 'searching' | 'success' | 'error'
  results: SearchResult[]
  hasSearched: boolean
  errorMessage?: string
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

  const [searchState, setSearchState] = useState<SearchState>({
    query: '',
    status: 'idle',
    results: [],
    hasSearched: false,
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
          return undefined
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
        return undefined
      }

      setExtractState({
        status: 'success',
        content: response.data,
        extractedAt: new Date().toLocaleTimeString(),
      })
      return response.data
    } catch (err) {
      setExtractState({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unexpected extraction failure.',
        extractedAt: new Date().toLocaleTimeString(),
      })
      return undefined
    }
  }, [connState.activeTab])



  // Save to IndexedDB Cache with safe end-to-end orchestration
  const handleSaveToCache = useCallback(async () => {
    setStorageState((prev) => ({
      ...prev,
      status: 'saving',
      errorMessage: undefined,
    }))

    try {
      // 1. Resolve extracted content
      let content = extractState.content
      if (!content) {
        content = await extractContent()
        if (!content) {
          setStorageState((prev) => ({
            ...prev,
            status: 'error',
            errorMessage: 'Unable to extract content from this page. Content script may not be supported on this URL.',
          }))
          return
        }
      }

      // 2. Resolve chunked document
      let chunked = chunkState.chunkedDoc
      if (!chunked) {
        chunked = chunkContent(content)
        setChunkState({
          status: 'success',
          chunkedDoc: chunked,
          chunkedAt: new Date().toLocaleTimeString(),
        })
      }

      // 3. Persist to IndexedDB
      const savedDoc = await saveDocumentAndChunks(content, chunked)
      await refreshStorageData(content.url)
      setStorageState((prev) => ({
        ...prev,
        status: 'saved',
        isCurrentPageCached: true,
        lastActionAt: new Date(savedDoc.updatedAt).toLocaleTimeString(),
      }))

      // Automatically refresh active search results if a query is active
      if (searchState.query.trim()) {
        const updatedResults = await searchUnifiedContent(searchState.query.trim(), {
          currentTabUrl: content.url,
          currentContent: content,
          currentChunkedDoc: chunked,
        })
        setSearchState((prev) => ({
          ...prev,
          results: updatedResults,
        }))
      }
    } catch (err) {
      setStorageState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to save document to IndexedDB.',
        lastActionAt: new Date().toLocaleTimeString(),
      }))
    }
  }, [extractState.content, chunkState.chunkedDoc, extractContent, refreshStorageData, searchState.query])

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
      // Clear any active search results immediately
      setSearchState((prev) => ({
        ...prev,
        results: [],
        hasSearched: false,
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

  // Unified Keyword Search Handler (Active Tab + Saved Pages)
  const handleSearch = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const query = searchState.query.trim()
    if (!query) {
      setSearchState((prev) => ({
        ...prev,
        status: 'idle',
        results: [],
        hasSearched: false,
        errorMessage: undefined,
      }))
      return
    }

    setSearchState((prev) => ({
      ...prev,
      status: 'searching',
      errorMessage: undefined,
    }))

    try {
      // If we don't have extracted content for current active tab, try to extract it non-persistently
      let currentContent = extractState.content
      if (!currentContent) {
        currentContent = await extractContent()
      }

      const results = await searchUnifiedContent(query, {
        currentTabUrl: connState.activeTab?.url,
        currentContent,
        currentChunkedDoc: chunkState.chunkedDoc,
      })

      setSearchState((prev) => ({
        ...prev,
        status: 'success',
        results,
        hasSearched: true,
      }))
    } catch (err) {
      setSearchState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Search failed.',
        hasSearched: true,
      }))
    }
  }, [searchState.query, extractState.content, extractContent, connState.activeTab?.url, chunkState.chunkedDoc])

  const handleClearSearch = useCallback(() => {
    setSearchState({
      query: '',
      status: 'idle',
      results: [],
      hasSearched: false,
    })
  }, [])

  const [showSaveTooltip, setShowSaveTooltip] = useState<boolean>(false)
  const saveTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSavePointerEnter = useCallback(() => {
    if (saveTooltipTimerRef.current) {
      clearTimeout(saveTooltipTimerRef.current)
    }
    saveTooltipTimerRef.current = setTimeout(() => {
      setShowSaveTooltip(true)
    }, 2000)
  }, [])

  const handleSavePointerLeave = useCallback(() => {
    if (saveTooltipTimerRef.current) {
      clearTimeout(saveTooltipTimerRef.current)
      saveTooltipTimerRef.current = null
    }
    setShowSaveTooltip(false)
  }, [])

  // Auto-load storage list and check connection on side panel mount & tab changes
  useEffect(() => {
    void refreshStorageData()
    const timer = setTimeout(() => {
      void testConnection()
    }, 0)

    const handleTabActivated = () => {
      void testConnection()
    }
    const handleTabUpdated = (_tabId: number, changeInfo: { status?: string }) => {
      if (changeInfo.status === 'complete') {
        void testConnection()
      }
    }

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(handleTabActivated)
      }
      if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(handleTabUpdated)
      }
    }

    return () => {
      clearTimeout(timer)
      if (saveTooltipTimerRef.current) {
        clearTimeout(saveTooltipTimerRef.current)
      }
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        if (chrome.tabs.onActivated) {
          chrome.tabs.onActivated.removeListener(handleTabActivated)
        }
        if (chrome.tabs.onUpdated) {
          chrome.tabs.onUpdated.removeListener(handleTabUpdated)
        }
      }
    }
  }, [testConnection, refreshStorageData])

  return (
    <div className="sidebar-container">
      {/* 1. Header: Bolt Icon, LagZero, Tagline, subtle status dot at top right */}
      <header className="sidebar-header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            <svg
              width="18"
              height="18"
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
          <div className="brand-text-wrap">
            <span className="brand-title">LagZero</span>
            <span className="brand-tagline">Your local-first browsing assistant</span>
          </div>
        </div>
        <div className="header-actions">
          <span
            className={`status-dot ${connState.status === 'connected' ? 'dot-active' : ''}`}
            title={connState.status === 'connected' ? 'Connected to tab' : 'Tab not connected'}
            aria-label={connState.status === 'connected' ? 'Connected' : 'Disconnected'}
          />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="sidebar-content">
        {/* 2. Heading */}
        <section className="search-section-wrap" aria-label="Search">
          <h1 className="search-main-heading">Find what matters</h1>

          {/* Unified Search Input Form with Telegram-style paper-plane button */}
          <form className="unified-search-form" onSubmit={handleSearch}>
            <div className="unified-search-input-box">
              <span className="search-leading-icon" aria-hidden="true">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                type="text"
                className="unified-search-input"
                placeholder="Search your browsing content..."
                value={searchState.query}
                onChange={(e) => setSearchState((prev) => ({ ...prev, query: e.target.value }))}
                aria-label="Search browsing content"
                disabled={searchState.status === 'searching'}
              />
              {searchState.query && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={handleClearSearch}
                  title="Clear search"
                  aria-label="Clear search input"
                >
                  &times;
                </button>
              )}
              <button
                type="submit"
                className="search-submit-plane-btn"
                disabled={!searchState.query.trim() || searchState.status === 'searching'}
                aria-label="Submit search"
                title="Search"
              >
                {searchState.status === 'searching' ? (
                  <svg
                    className="save-icon-spinner"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m22 2-7 20-4-9-9-4Z" />
                    <path d="M22 2 11 13" />
                  </svg>
                )}
              </button>
            </div>
          </form>

          {/* 3. Action Row: Bookmark Save button on Left, Green Connect Indicator on Right */}
          <div className="action-control-row">
            <div className="save-btn-wrapper">
              <button
                type="button"
                className={`minimal-bookmark-btn ${storageState.isCurrentPageCached ? 'cached' : ''}`}
                onClick={handleSaveToCache}
                disabled={storageState.status === 'saving'}
                onPointerEnter={handleSavePointerEnter}
                onPointerLeave={handleSavePointerLeave}
                onPointerDown={handleSavePointerLeave}
                onBlur={handleSavePointerLeave}
                aria-label={
                  storageState.status === 'saving'
                    ? 'Saving page locally…'
                    : storageState.isCurrentPageCached
                    ? 'Page already saved locally'
                    : 'Save page locally'
                }
              >
                {storageState.status === 'saving' ? (
                  <svg
                    className="save-icon-spinner"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg
                    className="save-icon-bookmark"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill={storageState.isCurrentPageCached ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                )}
              </button>
              {showSaveTooltip && (
                <div role="tooltip" className="save-tooltip" aria-hidden="true">
                  Save
                </div>
              )}
            </div>

            {/* Connection Status indicator on Right */}
            <div
              className={`minimal-connect-indicator ${connState.status === 'connected' ? 'connected' : 'disconnected'}`}
              title={
                connState.status === 'connected'
                  ? 'Connected to active tab'
                  : connState.status === 'checking'
                  ? 'Verifying tab connection…'
                  : 'Tab disconnected'
              }
            >
              <span className="connect-check-circle" aria-hidden="true">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </span>
              <span className="connect-label">Connect</span>
            </div>
          </div>
        </section>

        {/* 4. Search Results Area */}
        <section className="results-container-area" aria-label="Search results area">
          {!searchState.hasSearched ? (
            <div className="results-empty-state-box">
              <span className="results-empty-icon" aria-hidden="true">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </span>
              <h2 className="results-empty-title">Search results will appear here</h2>
              <p className="results-empty-desc">
                Find relevant information from this page and your saved content.
              </p>
            </div>
          ) : searchState.status === 'searching' ? (
            <div className="results-searching-box">
              <span className="mini-spinner" aria-hidden="true" />
              <span>Searching active page and saved content…</span>
            </div>
          ) : searchState.status === 'error' ? (
            <div className="results-error-box" role="alert">
              <span>{searchState.errorMessage || 'An error occurred during search.'}</span>
            </div>
          ) : searchState.results.length === 0 ? (
            <div className="results-empty-state-box">
              <span className="results-empty-icon" aria-hidden="true">
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <h2 className="results-empty-title">No matching passages found</h2>
              <p className="results-empty-desc">
                No passages in the current page or your saved cache matched &ldquo;{searchState.query}&rdquo;.
              </p>
            </div>
          ) : (
            <div className="ranked-results-list" aria-label="Search results">
              {searchState.results.map((res) => (
                <article
                  key={`${res.documentId}::${res.chunkIndex}`}
                  className="ranked-result-card"
                  onClick={() => handleSelectCachedDoc(res.documentId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleSelectCachedDoc(res.documentId)
                    }
                  }}
                  aria-label={`Result from ${res.documentTitle}, chunk ${res.chunkIndex + 1}`}
                >
                  <div className="result-top-line">
                    <span className="result-doc-title" title={res.documentTitle}>
                      {res.documentTitle}
                    </span>
                    <span className="result-source-badge">
                      {res.isCurrentPage ? 'Current Page' : 'Saved Page'}
                    </span>
                  </div>

                  <div className="result-meta-line">
                    <span className="result-chunk-tag">Passage #{res.chunkIndex + 1}</span>
                    {res.headingContext && (
                      <>
                        <span className="result-dot-sep">&bull;</span>
                        <span className="result-heading-text" title={res.headingContext}>
                          {res.headingContext}
                        </span>
                      </>
                    )}
                    {res.exactPhraseMatch && (
                      <span className="result-exact-badge">Exact Match</span>
                    )}
                  </div>

                  <div className="result-passage-box">
                    <p className="result-passage-p">
                      {renderHighlightedText(res.passageText, res.matchedTerms)}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* 5. Future AI Input Placeholder */}
        <section className="future-ai-section" aria-label="Future AI features">
          <div className="future-ai-box">
            <span className="future-ai-icon" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                <path d="M5 3v4" />
                <path d="M19 17v4" />
                <path d="M3 5h4" />
                <path d="M17 19h4" />
              </svg>
            </span>
            <input
              type="text"
              disabled
              placeholder="Ask anything about your saved content"
              aria-label="Ask anything about your saved content"
              className="future-ai-input"
            />
            <span className="future-ai-tag">Coming soon</span>
          </div>
        </section>
      </main>

      {/* 6. Footer: Local-first browser assistant (~0 KB used) and settings icon */}
      <footer className="sidebar-footer">
        <span className="footer-text">
          Local-first browser assistant ({storageState.storageEstimate || '~0 KB used'})
        </span>
        <button
          type="button"
          className="footer-settings-icon-btn"
          onClick={handleClearCache}
          title="Clear local cache"
          aria-label="Clear local cache"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </footer>
    </div>
  )
}
