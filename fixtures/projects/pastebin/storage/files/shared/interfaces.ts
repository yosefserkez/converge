// This file contains things shared with frontend

export type PasteLocation = "KV" | "R2"

export interface MetaResponse {
  lastModifiedAt: string
  createdAt: string
  expireAt: string
  sizeBytes: number
  location: PasteLocation
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
  // View limit. Both fields are absent for a paste without a limit.
  maxViews?: number
  viewsRemaining?: number
}

export interface PasteResponse extends MetaResponse {
  url: string
  manageUrl: string
  expirationSeconds: number
}

export interface MPUCreateResponse {
  name: string
  key: string
  uploadId: string
}

export interface SerializedPasteData {
  content: string
  metadata: MetaResponse
  name: string
  isBinary: boolean
  guessedEncoding: string | null
}

declare global {
  interface Window {
    __PASTE_DATA__?: SerializedPasteData
  }
}
