/**
 * Types and messaging contract for LagZero Chrome Extension.
 * Defines type-safe discriminated union messages for:
 * Side Panel <-> Background Service Worker <-> Content Script
 */

// 1. Basic Models
export interface TabInfo {
  id: number
  url: string
  title: string
}

export interface PageMetadata {
  url: string
  title: string
  readyState: DocumentReadyState
}

export interface ExtractedContent {
  title: string
  url: string
  textContent: string
  excerpt: string | null
  byline: string | null
  siteName: string | null
  publishedTime: string | null
  extractedAt: number
  isTruncated: boolean
  originalLength: number
}

// 2. Request Messages
export interface PingMessage {
  type: 'PING'
  target?: 'background' | 'content'
}

export interface GetActiveTabMessage {
  type: 'GET_ACTIVE_TAB'
}

export interface GetPageInfoMessage {
  type: 'GET_PAGE_INFO'
  tabId?: number
}

export interface ExtractPageContentMessage {
  type: 'EXTRACT_PAGE_CONTENT'
  tabId?: number
}

export type ExtensionRequest =
  | PingMessage
  | GetActiveTabMessage
  | GetPageInfoMessage
  | ExtractPageContentMessage

// 3. Response Messages
export interface SuccessResponse<T> {
  success: true
  data: T
}

export interface ErrorResponse {
  success: false
  error: {
    code:
      | 'RESTRICTED_PAGE'
      | 'NO_ACTIVE_TAB'
      | 'CONTENT_SCRIPT_UNREACHABLE'
      | 'UNKNOWN_MESSAGE'
      | 'INTERNAL_ERROR'
      | 'EXTRACTION_FAILED'
      | 'NO_READABLE_CONTENT'
    message: string
  }
}

export type ExtensionResponse<T = unknown> = SuccessResponse<T> | ErrorResponse

// Type helpers for specific message returns
export type PingResponse = ExtensionResponse<{ pong: true; target: 'background' | 'content'; timestamp: number }>
export type GetActiveTabResponse = ExtensionResponse<TabInfo>
export type GetPageInfoResponse = ExtensionResponse<PageMetadata>
export type ExtractPageContentResponse = ExtensionResponse<ExtractedContent>
