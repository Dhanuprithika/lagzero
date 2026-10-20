import { useCallback, useEffect, useState } from 'react'
import type {
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

export default function App() {
  const [connState, setConnState] = useState<ConnectionState>({
    status: 'idle',
    backgroundPong: false,
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
