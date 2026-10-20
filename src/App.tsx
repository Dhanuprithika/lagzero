import './App.css'

export default function App() {
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
          <span className="status-dot" aria-hidden="true" />
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
