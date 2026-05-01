/**
 * browser-service.mjs — Stub (browser service archived)
 * Original moved to archive/dead-code-20260501/
 * This stub prevents import errors in browser-api.mjs
 */

export async function browserNavigate() { return { success: false, error: 'Browser service not available' }; }
export async function browserScreenshot() { return { success: false, error: 'Browser service not available' }; }
export async function browserExtractText() { return { success: false, error: 'Browser service not available' }; }
export async function browserClick() { return { success: false, error: 'Browser service not available' }; }
export function getPoolStatus() { return { active: 0, idle: 0, total: 0, available: false }; }
