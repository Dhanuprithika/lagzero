import type { ExtensionRequest, GetPageInfoResponse, PingResponse } from './types/messaging'

/**
 * Minimal content script for LagZero (Phase 1, Milestone 2).
 * Responds to typed messages for basic page metadata and reachability checks.
 * Does NOT inspect cookies, credentials, or extract readability articles.
 */

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: PingResponse | GetPageInfoResponse) => void
  ) => {
    if (!message || typeof message !== 'object') {
      return false
    }

    if (message.type === 'PING') {
      sendResponse({
        success: true,
        data: {
          pong: true,
          target: 'content',
          timestamp: Date.now(),
        },
      })
      return true
    }

    if (message.type === 'GET_PAGE_INFO') {
      sendResponse({
        success: true,
        data: {
          title: document.title || '',
          url: window.location.href,
          readyState: document.readyState,
        },
      })
      return true
    }

    return false
  }
)
