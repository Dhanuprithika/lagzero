import type {
  ExtensionRequest,
  ExtensionResponse,
  GetActiveTabResponse,
  GetPageInfoResponse,
  PingResponse,
  TabInfo,
} from './types/messaging'

// Configure side panel behavior to open when toolbar action is clicked
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.error('Failed to set side panel behavior:', err)
    })
  }
})

/**
 * Checks if a URL is restricted by Chrome policies from running content scripts.
 */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true
  const lower = url.toLowerCase()
  return (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('view-source:') ||
    lower.startsWith('devtools://') ||
    lower.includes('chromewebstore.google.com') ||
    lower.includes('chrome.google.com/webstore')
  )
}

/**
 * Retrieves the currently active tab.
 * Tries lastFocusedWindow: true first, then currentWindow: true,
 * and finally any active tab across windows.
 */
async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (lastFocused.length > 0 && lastFocused[0].id !== undefined) {
    return lastFocused[0]
  }
  const currentWin = await chrome.tabs.query({ active: true, currentWindow: true })
  if (currentWin.length > 0 && currentWin[0].id !== undefined) {
    return currentWin[0]
  }
  const allActive = await chrome.tabs.query({ active: true })
  const normalTab = allActive.find((t) => t.url && !isRestrictedUrl(t.url))
  return normalTab || allActive[0]
}

// Background message dispatcher
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void
  ) => {
    if (!message || typeof message !== 'object' || !message.type) {
      sendResponse({
        success: false,
        error: {
          code: 'UNKNOWN_MESSAGE',
          message: 'Malformed or invalid message received.',
        },
      })
      return false
    }

    // Handle PING to background
    if (message.type === 'PING') {
      const response: PingResponse = {
        success: true,
        data: {
          pong: true,
          target: 'background',
          timestamp: Date.now(),
        },
      }
      sendResponse(response)
      return false
    }

    // Handle GET_ACTIVE_TAB
    if (message.type === 'GET_ACTIVE_TAB') {
      getActiveTab()
        .then((tab) => {
          if (!tab || tab.id === undefined) {
            const resp: GetActiveTabResponse = {
              success: false,
              error: {
                code: 'NO_ACTIVE_TAB',
                message: 'No active tab found in the current window.',
              },
            }
            sendResponse(resp)
            return
          }

          const tabInfo: TabInfo = {
            id: tab.id,
            url: tab.url || '',
            title: tab.title || '',
          }

          sendResponse({
            success: true,
            data: tabInfo,
          })
        })
        .catch((err) => {
          sendResponse({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'Failed to query active tab.',
            },
          })
        })
      return true // Keep channel open for async response
    }

    // Handle GET_PAGE_INFO (forwarded to active tab content script)
    if (message.type === 'GET_PAGE_INFO') {
      const resolveTab = async () => {
        if (typeof message.tabId === 'number') {
          try {
            return await chrome.tabs.get(message.tabId)
          } catch (tabErr) {
            console.warn('[LagZero Background] Could not find tab by ID:', message.tabId, tabErr)
          }
        }
        return await getActiveTab()
      }

      resolveTab()
        .then(async (tab) => {
          if (!tab || tab.id === undefined) {
            const resp: GetPageInfoResponse = {
              success: false,
              error: {
                code: 'NO_ACTIVE_TAB',
                message: 'No active tab available to query.',
              },
            }
            sendResponse(resp)
            return
          }

          if (isRestrictedUrl(tab.url)) {
            const resp: GetPageInfoResponse = {
              success: false,
              error: {
                code: 'RESTRICTED_PAGE',
                message: `Page "${tab.url || 'restricted'}" does not support content scripts (browser internal, webstore, or empty page).`,
              },
            }
            sendResponse(resp)
            return
          }

          try {
            const contentResponse = await chrome.tabs.sendMessage<ExtensionRequest, ExtensionResponse>(
              tab.id,
              { type: 'GET_PAGE_INFO' }
            )

            if (!contentResponse) {
              sendResponse({
                success: false,
                error: {
                  code: 'CONTENT_SCRIPT_UNREACHABLE',
                  message: 'No response from content script. Refreshing the tab will inject it.',
                },
              })
              return
            }

            sendResponse(contentResponse)
          } catch (sendErr) {
            const chromeErrorMsg = chrome.runtime.lastError?.message || (sendErr instanceof Error ? sendErr.message : String(sendErr))
            console.warn('[LagZero Background] chrome.tabs.sendMessage error:', chromeErrorMsg)
            sendResponse({
              success: false,
              error: {
                code: 'CONTENT_SCRIPT_UNREACHABLE',
                message: `Content script not reachable on tab ${tab.id} (${chromeErrorMsg}). Refresh the webpage to inject it.`,
              },
            })
          }
        })
        .catch((err) => {
          sendResponse({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'Error relaying message to content script.',
            },
          })
        })
      return true // Keep channel open for async response
    }

    // Handle EXTRACT_PAGE_CONTENT (forwarded to active tab content script)
    if (message.type === 'EXTRACT_PAGE_CONTENT') {
      const resolveTab = async () => {
        if (typeof message.tabId === 'number') {
          try {
            return await chrome.tabs.get(message.tabId)
          } catch (tabErr) {
            console.warn('[LagZero Background] Could not find tab by ID:', message.tabId, tabErr)
          }
        }
        return await getActiveTab()
      }

      resolveTab()
        .then(async (tab) => {
          if (!tab || tab.id === undefined) {
            sendResponse({
              success: false,
              error: {
                code: 'NO_ACTIVE_TAB',
                message: 'No active tab available for extraction.',
              },
            })
            return
          }

          if (isRestrictedUrl(tab.url)) {
            sendResponse({
              success: false,
              error: {
                code: 'RESTRICTED_PAGE',
                message: `Page "${tab.url || 'restricted'}" does not allow content extraction (internal browser or webstore page).`,
              },
            })
            return
          }

          try {
            const extractResponse = await chrome.tabs.sendMessage<ExtensionRequest, ExtensionResponse>(
              tab.id,
              { type: 'EXTRACT_PAGE_CONTENT' }
            )

            if (!extractResponse) {
              sendResponse({
                success: false,
                error: {
                  code: 'CONTENT_SCRIPT_UNREACHABLE',
                  message: 'No response from content script. Please refresh the webpage to ensure the extraction script is active.',
                },
              })
              return
            }

            sendResponse(extractResponse)
          } catch (sendErr) {
            const chromeErrorMsg = chrome.runtime.lastError?.message || (sendErr instanceof Error ? sendErr.message : String(sendErr))
            console.warn('[LagZero Background] chrome.tabs.sendMessage EXTRACT_PAGE_CONTENT error:', chromeErrorMsg)
            sendResponse({
              success: false,
              error: {
                code: 'CONTENT_SCRIPT_UNREACHABLE',
                message: `Cannot extract content on tab ${tab.id} (${chromeErrorMsg}). Refresh the webpage to inject the content script.`,
              },
            })
          }
        })
        .catch((err) => {
          sendResponse({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'Error relaying extraction message to content script.',
            },
          })
        })
      return true // Keep channel open for async response
    }

    sendResponse({
      success: false,
      error: {
        code: 'UNKNOWN_MESSAGE',
        message: `Unknown message type: ${(message as { type: string }).type}`,
      },
    })
    return false
  }
)
