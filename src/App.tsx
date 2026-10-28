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
import { searchCachedContent } from './utils/search'
import {
  checkDocumentCacheStatus,
  clearAllCache,
  deleteDocument,
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

const GREETINGS = [
  'What would you like to do?',
  'Ready to explore your saved web content.',
  'What shall we review today?',
]

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

  // Toast notification for verified connection
  const [connectionToast, setConnectionToast] = useState<{
    visible: boolean
    title?: string
  }>({ visible: false })
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastConnectedTabIdRef = useRef<number | null>(null)

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

      // Show temporary connection toast if new tab connected
      if (lastConnectedTabIdRef.current !== activeTab.id) {
        lastConnectedTabIdRef.current = activeTab.id
        if (toastTimerRef.current) {
          clearTimeout(toastTimerRef.current)
        }
        setConnectionToast({
          visible: true,
          title: pageInfoResponse.data.title || activeTab.title,
        })
        toastTimerRef.current = setTimeout(() => {
          setConnectionToast({ visible: false })
          toastTimerRef.current = null
        }, 5500)
      }

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
        const updatedResults = await searchCachedContent(searchState.query.trim())
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

        // Automatically refresh active search results if a query is active
        if (searchState.query.trim()) {
          const updatedResults = await searchCachedContent(searchState.query.trim())
          setSearchState((prev) => ({
            ...prev,
            results: updatedResults,
          }))
        }
      } catch (err) {
        setStorageState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : 'Failed to delete cached document.',
        }))
      }
    },
    [storageState.selectedDoc?.document.id, refreshStorageData, connState.activeTab?.url, searchState.query]
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

  // Milestone 6 Local Keyword Search Handler
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
      const results = await searchCachedContent(query)
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
  }, [searchState.query])

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
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current)
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

  const currentPageTitle =
    connState.pageInfo?.title ||
    connState.activeTab?.title ||
    (connState.status === 'checking' ? 'Detecting active page…' : 'No active page detected')

  const currentPageUrl = connState.pageInfo?.url || connState.activeTab?.url

  return (
    <div className="sidebar-container">
      {/* 1. Header with branding & tagline */}
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

      {/* 2. Connection Notification Toast (Auto-dismissing) */}
      {connectionToast.visible && (
        <aside className="connection-toast" role="status" aria-live="polite">
          <div className="toast-content">
            <span className="toast-indicator" aria-hidden="true" />
            <div className="toast-text">
              <span className="toast-title">Connected to this tab</span>
              {connectionToast.title && (
                <span className="toast-subtitle" title={connectionToast.title}>
                  {connectionToast.title}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="toast-close-btn"
            onClick={() => setConnectionToast({ visible: false })}
            aria-label="Dismiss notification"
          >
            &times;
          </button>
        </aside>
      )}

      {/* Main Content Area */}
      <main className="sidebar-content">
        {/* 3. Greeting Section */}
        <section className="greeting-section" aria-label="Assistant greeting">
          <h1 className="greeting-text">{GREETINGS[0]}</h1>
        </section>

        {/* 4. Current Page Section with Compact Save Button */}
        <section className="current-page-card" aria-label="Current page">
          <div className="current-page-header">
            <span className="section-label">Current page</span>
            <div className="save-btn-wrapper">
              <button
                type="button"
                className={`bookmark-save-btn ${storageState.isCurrentPageCached ? 'cached' : ''}`}
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
                    ? 'Update saved page locally'
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
          </div>

          <div className="current-page-body">
            <div className="page-title-row">
              <span className="page-title-text" title={currentPageTitle}>
                {currentPageTitle}
              </span>
            </div>

            {currentPageUrl && (
              <span className="page-url-text" title={currentPageUrl}>
                {currentPageUrl}
              </span>
            )}

            {/* Operation Feedback */}
            {storageState.status === 'saving' && (
              <div className="status-msg-row saving" role="status">
                <span className="mini-spinner" aria-hidden="true" />
                <span>Saving page to local storage…</span>
              </div>
            )}

            {storageState.status === 'saved' && (
              <div className="status-msg-row success" role="status">
                <span className="status-check-icon" aria-hidden="true">✓</span>
                <span>Saved locally{storageState.lastActionAt ? ` at ${storageState.lastActionAt}` : ''}</span>
              </div>
            )}

            {storageState.isCurrentPageCached && storageState.status !== 'saving' && storageState.status !== 'saved' && (
              <div className="status-msg-row cached">
                <span>Already saved in local cache</span>
              </div>
            )}

            {storageState.status === 'error' && storageState.errorMessage && (
              <div className="status-msg-row error" role="alert">
                <span>{storageState.errorMessage}</span>
              </div>
            )}

            {connState.status === 'error' && connState.errorMessage && (
              <div className="status-msg-row error" role="alert">
                <span>{connState.errorMessage}</span>
              </div>
            )}
          </div>
        </section>

        {/* 5. Saved Pages Section */}
        <section className="saved-pages-section" aria-label="Saved pages">
          <div className="saved-pages-header">
            <div className="saved-pages-title-wrap">
              <span className="section-label">Saved pages</span>
              <span className="section-count-badge" aria-label={`${storageState.cachedList.length} pages saved`}>
                {storageState.cachedList.length}
              </span>
            </div>
            {storageState.cachedList.length > 0 && (
              <button
                type="button"
                className="clear-cache-subtle-btn"
                onClick={handleClearCache}
                title="Clear all saved pages from local cache"
              >
                Clear all
              </button>
            )}
          </div>

          {storageState.cachedList.length === 0 ? (
            <div className="saved-empty-box">
              <span>No pages saved yet. Click the bookmark icon above to save this page locally.</span>
            </div>
          ) : (
            <div className="saved-pages-list" aria-label="List of saved pages">
              {storageState.cachedList.map((doc) => {
                let hostname: string
                try {
                  hostname = new URL(doc.sourceUrl).hostname.replace(/^www\./, '')
                } catch {
                  hostname = doc.sourceUrl
                }
                const isSelected = storageState.selectedDoc?.document.id === doc.id

                return (
                  <div
                    key={doc.id}
                    className={`saved-page-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectCachedDoc(doc.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        handleSelectCachedDoc(doc.id)
                      }
                    }}
                    aria-label={`View cached document ${doc.title}`}
                  >
                    <div className="saved-item-header">
                      <span className="saved-item-title" title={doc.title}>
                        {doc.title || 'Untitled Page'}
                      </span>
                      <button
                        type="button"
                        className="saved-item-delete-btn"
                        onClick={(e) => handleDeleteCachedDoc(doc.id, e)}
                        title="Delete page from cache"
                        aria-label={`Delete ${doc.title} from cache`}
                      >
                        &times;
                      </button>
                    </div>
                    <div className="saved-item-meta-row">
                      <span className="saved-item-domain" title={doc.sourceUrl}>
                        {hostname}
                      </span>
                      <span className="saved-item-meta-dot">&bull;</span>
                      <span className="saved-item-meta-chunk">{doc.totalChunks} chunks</span>
                      <span className="saved-item-meta-dot">&bull;</span>
                      <span className="saved-item-meta-date">
                        {new Date(doc.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Selected Cached Document Detail View (Offline) */}
          {storageState.selectedDoc && (
            <div className="selected-cache-detail" aria-label="Selected cached document detail">
              <div className="selected-cache-header">
                <div className="selected-cache-title-wrap">
                  <span className="selected-cache-badge">Cached Content (Offline)</span>
                  <h2 className="selected-cache-title">{storageState.selectedDoc.document.title}</h2>
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
        </section>

        {/* 6. Search Section */}
        <section className="search-section" aria-label="Search saved content">
          <div className="search-section-header">
            <span className="section-label">Search saved content</span>
            {searchState.hasSearched && searchState.status === 'success' && (
              <span className="search-count-badge" aria-label={`${searchState.results.length} matches found`}>
                {searchState.results.length} match{searchState.results.length === 1 ? '' : 'es'}
              </span>
            )}
          </div>

          <form className="search-form" onSubmit={handleSearch}>
            <div className="search-input-wrapper">
              <input
                type="text"
                className="search-input"
                placeholder="Search across all saved pages…"
                value={searchState.query}
                onChange={(e) => setSearchState((prev) => ({ ...prev, query: e.target.value }))}
                aria-label="Search query"
                disabled={searchState.status === 'searching'}
              />
              {searchState.query && (
                <button
                  type="button"
                  className="search-clear-input-btn"
                  onClick={handleClearSearch}
                  title="Clear search"
                  aria-label="Clear search input"
                >
                  &times;
                </button>
              )}
            </div>
            <button
              type="submit"
              className="search-btn primary"
              disabled={!searchState.query.trim() || searchState.status === 'searching'}
            >
              {searchState.status === 'searching' ? 'Searching…' : 'Search'}
            </button>
          </form>

          {/* Empty cache state */}
          {storageState.cachedList.length === 0 && (
            <div className="search-hint-box">
              <span>Save pages using the bookmark icon above to enable offline search.</span>
            </div>
          )}

          {/* Searching indicator */}
          {searchState.status === 'searching' && (
            <div className="search-loading-box">
              <span className="loading-spinner" aria-hidden="true" />
              <span className="loading-text">Scanning saved passages in IndexedDB…</span>
            </div>
          )}

          {/* Error state */}
          {searchState.status === 'error' && searchState.errorMessage && (
            <div className="error-box" role="alert">
              <span className="error-text">{searchState.errorMessage}</span>
            </div>
          )}

          {/* No matches hint */}
          {searchState.hasSearched && searchState.status === 'success' && searchState.results.length === 0 && (
            <div className="search-empty-box">
              <span>No saved passages matched &ldquo;{searchState.query}&rdquo;. Try another term.</span>
            </div>
          )}

          {/* Ranked Results List */}
          {searchState.results.length > 0 && (
            <div className="search-results-list" aria-label="Search results">
              {searchState.results.map((res) => (
                <article
                  key={res.chunkId}
                  className="search-result-item"
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
                  <div className="search-result-top">
                    <span className="search-result-doc-title" title={res.documentTitle}>
                      {res.documentTitle}
                    </span>
                    <span className="search-result-score-pill">
                      Score: {res.relevanceScore}
                    </span>
                  </div>

                  <div className="search-result-meta-row">
                    <span className="search-result-chunk-badge">Chunk #{res.chunkIndex + 1}</span>
                    {res.headingContext && (
                      <>
                        <span className="search-result-meta">&bull;</span>
                        <span className="search-result-heading" title={res.headingContext}>
                          {res.headingContext}
                        </span>
                      </>
                    )}
                    {res.exactPhraseMatch && (
                      <span className="search-match-badge exact">Exact Phrase</span>
                    )}
                  </div>

                  <div className="search-result-passage" tabIndex={0}>
                    <p className="search-passage-text">
                      {renderHighlightedText(res.passageText, res.matchedTerms)}
                    </p>
                  </div>

                  <div className="search-result-url" title={res.sourceUrl}>
                    {res.sourceUrl}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* 7. Future AI Placeholder Input */}
        <section className="input-section" aria-label="Future AI features">
          <div className="input-wrapper">
            <input
              type="text"
              disabled
              placeholder="Ask anything about saved pages (Coming soon)"
              aria-label="Ask anything about saved pages (Coming soon)"
              className="placeholder-input"
            />
          </div>
        </section>
      </main>

      {/* 8. Minimal Footer with subtle storage estimate */}
      <footer className="sidebar-footer">
        <span className="footer-text">
          Local-first browser assistant
          {storageState.storageEstimate ? ` (~${storageState.storageEstimate} used)` : ''}
        </span>
      </footer>
    </div>
  )
}
