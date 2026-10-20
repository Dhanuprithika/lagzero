// Background service worker for LagZero Chrome Extension (Phase 1, Milestone 1)

// Configure the side panel behavior to open on action (toolbar icon) click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.error('Failed to set side panel behavior:', err)
    })
  }
})
