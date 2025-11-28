/**
 * src/core/parser.js
 * * Production-grade SMTP Response Parser
 * Implements RFC 5321 (Multi-line) and RFC 3463 (Enhanced Status Codes)
 * * 2025 Standards:
 * - Strict hyphen/space separator handling for multi-line responses
 * - Enhanced Status Code (x.y.z) extraction and classification
 * - Classification of Soft Fails (4xx) vs Hard Fails (5xx)
 */

/**
 * Result object for parsed SMTP responses
 * @typedef {Object} SmtpResponse
 * @property {number} code - The 3-digit SMTP status code (e.g., 250, 550)
 * @property {string|null} enhancedCode - The x.y.z enhanced code (e.g., "5.1.1")
 * @property {string} message - The human-readable text part
 * @property {string[]} lines - Raw lines of the multi-line response
 * @property {string} classification - SUCCESS, TRANSIENT_FAIL, or PERMANENT_FAIL
 */

const CLASSIFICATION = Object.freeze({
  SUCCESS: "SUCCESS", // 2xx
  INTERMEDIATE: "INTERMEDIATE", // 3xx (e.g. 354 Start Mail)
  TRANSIENT_FAIL: "TRANSIENT_FAIL", // 4xx (Retry later)
  PERMANENT_FAIL: "PERMANENT_FAIL", // 5xx (Do not retry)
  PROTOCOL_ERROR: "PROTOCOL_ERROR", // Non-compliant response
});

/**
 * Classifies an SMTP code into a high-level category
 * @param {number} code
 * @returns {string} One of CLASSIFICATION constants
 */
function classifyCode(code) {
  if (code >= 200 && code < 300) return CLASSIFICATION.SUCCESS;
  if (code >= 300 && code < 400) return CLASSIFICATION.INTERMEDIATE;
  if (code >= 400 && code < 500) return CLASSIFICATION.TRANSIENT_FAIL;
  if (code >= 500 && code < 600) return CLASSIFICATION.PERMANENT_FAIL;
  return CLASSIFICATION.PROTOCOL_ERROR;
}

/**
 * Extracts the Enhanced Status Code (RFC 3463) if present
 * Pattern: 3-digit code + space + x.y.z + space + text
 * @param {string} line - Single line of SMTP response
 * @returns {string|null} The enhanced code (e.g. "5.1.1") or null
 */
function extractEnhancedCode(line) {
  // Regex looks for: 3 digits, space/hyphen, then x.y.z pattern
  const match = line.match(/^\d{3}[ -](\d{1,3}\.\d{1,3}\.\d{1,3})\s/);
  return match ? match[1] : null;
}

/**
 * Parses a complete raw SMTP response buffer into a structured object
 * Handles multi-line responses where intermediate lines use '-' separator.
 * * @param {string} rawBuffer - The accumulated buffer from the socket
 * @returns {SmtpResponse|null} The parsed object, or null if response is incomplete
 */
function parseSmtpResponse(rawBuffer) {
  if (!rawBuffer) return null;

  // Split buffer into lines (handle CRLF or LF)
  const lines = rawBuffer.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1];

  // Check if the message is complete
  // RFC 5321: Final line has "Code<SP>" or is just "Code"
  // Intermediate lines have "Code-"
  const lastLineMatch = lastLine.match(/^(\d{3})(?: (.*)|$)/);

  // If the last line uses a hyphen separator (e.g. "250-"), it's not finished.
  const isIntermediate = /^\d{3}-/.test(lastLine);

  if (!lastLineMatch || isIntermediate) {
    return null; // Response incomplete, wait for more data
  }

  // At this point, we have a complete message.
  const code = parseInt(lastLineMatch[1], 10);
  const rawMessage = lines
    .map((l) => l.substring(4))
    .join(" ")
    .trim();

  // Try to find enhanced code in the *first* line usually, or any line
  let enhancedCode = null;
  for (const line of lines) {
    const ec = extractEnhancedCode(line);
    if (ec) {
      enhancedCode = ec;
      break;
    }
  }

  // Clean message: Remove enhanced code from text if present to avoid redundancy
  let cleanMessage = rawMessage;
  if (enhancedCode) {
    cleanMessage = cleanMessage.replace(enhancedCode, "").trim();
    // Clean up potential double spaces caused by removal
    cleanMessage = cleanMessage.replace(/\s+/g, " ");
  }

  return {
    code,
    enhancedCode,
    message: cleanMessage,
    lines: lines,
    classification: classifyCode(code),
  };
}

module.exports = {
  parseSmtpResponse,
  CLASSIFICATION,
  extractEnhancedCode,
};
