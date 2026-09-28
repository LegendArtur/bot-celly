import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CONTENT_TYPES: Record<string, string> = {
  "htmx.min.js": "application/javascript; charset=utf-8",
  "hx-sse.min.js": "application/javascript; charset=utf-8",
  "app.js": "application/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
}

export const ALLOWED_ASSETS = Object.keys(CONTENT_TYPES)

export function isAllowedAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, name)
}

export interface AssetFile {
  body: Buffer
  contentType: string
}

const ASSET_DIR = new URL("../../assets/admin/", import.meta.url)

export function readAsset(name: string): AssetFile | undefined {
  if (!isAllowedAsset(name)) return undefined
  try {
    const body = readFileSync(new URL(name, ASSET_DIR))
    return { body, contentType: CONTENT_TYPES[name]! }
  } catch {
    return undefined
  }
}

export const assetDirPath = fileURLToPath(ASSET_DIR)
