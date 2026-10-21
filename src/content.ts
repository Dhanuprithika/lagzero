import { Readability } from '@mozilla/readability'
import type {
  ExtensionRequest,
  ExtractPageContentResponse,
  GetPageInfoResponse,
  PingResponse,
} from './types/messaging'

/**
 * Content script for LagZero (Phase 1, Milestone 3).
 * - Responds to typed messages for basic page metadata (GET_PAGE_INFO).
 * - Responds to PING for reachability.
 * - Extracts clean article content using Mozilla Readability (EXTRACT_PAGE_CONTENT).
 *
 * Security & Integrity Constraints:
 * - Operates only on a safe clone of the document (does not mutate the live DOM).
 * - Does not access cookies, localStorage, auth tokens, or form data.
 * - Caps extracted text to 100,000 characters to prevent message bus exhaustion.
 */

const MAX_EXTRACTED_CHARS = 100000

// Observable diagnostic signal confirming script execution in webpage context
console.log('[LagZero Content] Content script active on:', window.location.href)

function extractArticleContent(): ExtractPageContentResponse {
  try {
    // 1. Create a safe clone of document to ensure live page DOM is never mutated
    const clonedDoc = document.cloneNode(true) as Document

    // 2. Parse using Mozilla Readability
    const reader = new Readability(clonedDoc)
    const article = reader.parse()

    if (!article) {
      return {
        success: false,
        error: {
          code: 'NO_READABLE_CONTENT',
          message: 'Readability could not identify readable article or document content on this page.',
        },
      }
    }

    const rawText = (article.textContent || '').trim()
    if (!rawText || rawText.length < 50) {
      return {
        success: false,
        error: {
          code: 'NO_READABLE_CONTENT',
          message: 'The page content is too short or does not contain sufficient readable text.',
        },
      }
    }

    const originalLength = rawText.length
    const isTruncated = originalLength > MAX_EXTRACTED_CHARS
    const textContent = isTruncated
      ? rawText.slice(0, MAX_EXTRACTED_CHARS)
      : rawText

    return {
      success: true,
      data: {
        title: article.title || document.title || '',
        url: window.location.href,
        textContent,
        excerpt: article.excerpt ? article.excerpt.trim() : null,
        byline: article.byline ? article.byline.trim() : null,
        siteName: article.siteName ? article.siteName.trim() : null,
        publishedTime: article.publishedTime ? article.publishedTime.trim() : null,
        extractedAt: Date.now(),
        isTruncated,
        originalLength,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'EXTRACTION_FAILED',
        message: err instanceof Error ? err.message : 'An unexpected error occurred during page content extraction.',
      },
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (
      response: PingResponse | GetPageInfoResponse | ExtractPageContentResponse
    ) => void
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

    if (message.type === 'EXTRACT_PAGE_CONTENT') {
      const response = extractArticleContent()
      sendResponse(response)
      return true
    }

    return false
  }
)
