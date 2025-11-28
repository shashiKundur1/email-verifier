/**
 * src/utils/mapper.js
 * * Maps internal verification results to the final JSON output schema.
 */

const { CLASSIFICATION } = require("../core/parser");
// FIX: Import STATUS from the new independent file
const { STATUS } = require("../core/status");

const PATTERNS = Object.freeze({
  FULL_INBOX:
    /quota|full|insufficient storage|storage exceeded|limit exceeded/i,
  DISABLED:
    /disabled|suspended|inactive|deactivated|account closed|not active/i,
});

function formatOutput(internalResult) {
  const output = {
    can_connect_smtp: false,
    is_deliverable: false,
    is_catch_all: false,
    has_full_inbox: false,
    is_disabled: false,
  };

  const details = internalResult.details || {};

  // 1. Connection Status
  if (details.smtpCode) {
    output.can_connect_smtp = true;
  }

  // 2. Deliverability Status
  if (internalResult.status === STATUS.VALID) {
    output.is_deliverable = true;
  } else if (internalResult.status === STATUS.CATCH_ALL) {
    output.is_deliverable = true;
    output.is_catch_all = true;
  }

  // 3. Catch-All Status (Explicit)
  if (details.catchAllActive) {
    output.is_catch_all = true;
  }

  // 4. Detailed Rejection Analysis
  const code = details.smtpCode;
  const msg = details.smtpMessage || "";

  if (
    (code === 452 || code === 552 || code === 554) &&
    PATTERNS.FULL_INBOX.test(msg)
  ) {
    output.has_full_inbox = true;
    output.is_deliverable = false;
  }

  if (code === 550 && PATTERNS.DISABLED.test(msg)) {
    output.is_disabled = true;
    output.is_deliverable = false;
  }

  return output;
}

module.exports = { formatOutput };
