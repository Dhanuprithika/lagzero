import { useCallback, useEffect, useState } from 'react'
import type {
  ExtractedContent,
  ExtractPageContentResponse,
  GetActiveTabResponse,
  GetPageInfoResponse,
  PageMetadata,
  PingResponse,
  TabInfo,
} from './types/messaging'
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

export default function App() {
  const [connState, setConnState] = useState<ConnectionState>({
    status: 'idle',
    backgroundPong: false,
  })

  const [extractState, setExtractState] = useState<ExtractionState>({
    status: 'idle',
  })

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
    } catch (err) {
      setConnState({
        status: 'error',
        backgroundPong: false,
        errorMessage: err instanceof Error ? err.message : 'Unexpected connection error.',
        lastTestedAt: new Date().toLocaleTimeString(),
      })
    }
  }, [])

  const extractContent = useCallback(async () => {
    setExtractState({
      status: 'extracting',
      errorMessage: undefined,
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

  // Auto-check connection upon sidebar load
  useEffect(() => {
    const timer = setTimeout(() => {
      void testConnection()
    }, 0)
    return () => clearTimeout(timer)
  }, [testConnection])

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
