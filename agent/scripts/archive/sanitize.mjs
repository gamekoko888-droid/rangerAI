// XSS Sanitization (Iter-11)
const DANGEROUS_TAGS = /<script[^>]*>[\s\S]*?<\/script>/gi;
const DANGEROUS_ATTRS = /\s(on\w+|javascript:)[^\s>]*/gi;
const DANGEROUS_IFRAMES = /<iframe[^>]*>[\s\S]*?<\/iframe>/gi;

export function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return html;
  // Iterate 41+: Remove null bytes to prevent WebSocket 'message must not contain null bytes' error
  const clean = html.replace(/\0/g, "");
  return clean.replace(DANGEROUS_TAGS, "").replace(DANGEROUS_IFRAMES, "").replace(DANGEROUS_ATTRS, "");
}

export function sanitizeText(text) {
  if (!text || typeof text !== "string") return text;
  // Iterate 41+: Remove null bytes
  const clean = text.replace(/\0/g, "");
  return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
