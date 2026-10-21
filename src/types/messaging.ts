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

export interface ContentChunk {
  id: string
  index: number // 0-based sequence index
  text: string
  characterCount: number
  headingContext: string | null
  documentTitle: string
  sourceUrl: string
  extractedAt: number
}

export interface ChunkedDocument {
  sourceUrl: string
  title: string
  totalChunks: number
  totalCharacters: number
  extractedAt: number
  chunks: ContentChunk[]
}

// Milestone 5: Persistent Storage Models (IndexedDB)
export interface CachedDocument {
  id: string // Normalized URL as stable primary key
  title: string
  sourceUrl: string // Original URL
  extractedText: string
  excerpt: string | null
  byline: string | null
  siteName: string | null
  publishedTime: string | null
  extractedAt: number
  cachedAt: number
  updatedAt: number
  totalChunks: number
  totalCharacters: number
  schemaVersion: number
}

export interface CachedChunk {
  id: string // Composite key: `${documentId}::${chunkIndex}`
  documentId: string
  chunkIndex: number
  text: string
  characterCount: number
  headingContext: string | null
  documentTitle: string
  sourceUrl: string
  extractedAt: number
}

export interface CachedDocumentSummary {
  id: string
  title: string
  sourceUrl: string
  cachedAt: number
  updatedAt: number
  totalChunks: number
  totalCharacters: number
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
