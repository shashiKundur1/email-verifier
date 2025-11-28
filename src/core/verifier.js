/**
 * src/core/verifier.js
 * * Production-grade Email Verification Logic
 */

const { getMXRecords } = require("./dns");
const SmtpClient = require("./smtp-client");
const { randomDelay } = require("../utils/sleep");
const crypto = require("crypto");
const constants = require("../config/constants");
const { CLASSIFICATION } = require("./parser");
// FIX: Import STATUS from the new independent file
const { STATUS } = require("./status");

function generateNonceEmail(domain) {
  const randomStr = crypto.randomBytes(6).toString("hex");
  return `verify-${randomStr}@${domain}`;
}

async function verifyEmail(email, options = {}) {
  const results = {
    email,
    domain: null,
    mx: null,
    status: STATUS.UNKNOWN,
    reason: null,
    details: {
      smtpCode: null,
      smtpMessage: null,
      catchAllActive: false,
      greylisted: false,
    },
  };

  // 1. Syntax Check
  if (!email || !email.includes("@")) {
    results.status = STATUS.INVALID;
    results.reason = "Invalid email syntax";
    return results;
  }

  const [user, domain] = email.split("@");
  if (!user || !domain) {
    results.status = STATUS.INVALID;
    results.reason = "Invalid email syntax";
    return results;
  }
  results.domain = domain;

  const senderEmail = options.senderEmail || `verify@${domain}`;

  try {
    // 2. DNS Lookup
    const mxResult = await getMXRecords(domain);
    if (!mxResult.success || mxResult.records.length === 0) {
      results.status = STATUS.INVALID;
      results.reason = "No MX records found";
      return results;
    }
    const mxRecord = mxResult.records[0];
    results.mx = mxRecord.exchange;

    // 3. Connect to SMTP
    const client = new SmtpClient(
      mxRecord.exchange,
      constants.SMTP.PORT,
      options
    );

    try {
      await client.connect();
      await client.sendHello(options.helo || constants.SMTP.DEFAULT_HELO);
      await client.sendMailFrom(senderEmail);

      // 4. Catch-All Probe
      const nonceEmail = generateNonceEmail(domain);
      const nonceRes = await client.sendRcptTo(nonceEmail);

      if (nonceRes.classification === CLASSIFICATION.SUCCESS) {
        results.details.catchAllActive = true;
      } else if (nonceRes.classification === CLASSIFICATION.TRANSIENT_FAIL) {
        results.details.greylisted = true;
      }

      // 5. Verify Target Email
      const targetRes = await client.sendRcptTo(email);

      results.details.smtpCode = targetRes.code;
      results.details.smtpMessage = targetRes.message;

      // 6. Final Classification Logic
      if (
        results.details.greylisted ||
        targetRes.classification === CLASSIFICATION.TRANSIENT_FAIL
      ) {
        results.status = STATUS.UNKNOWN;
        results.reason = "Greylisted (Try again later)";
      } else if (targetRes.classification === CLASSIFICATION.PERMANENT_FAIL) {
        results.status = STATUS.INVALID;
        results.reason = "Recipient rejected";
      } else if (targetRes.classification === CLASSIFICATION.SUCCESS) {
        if (results.details.catchAllActive) {
          results.status = STATUS.CATCH_ALL;
          results.reason = "Domain is Catch-All";
        } else {
          results.status = STATUS.VALID;
          results.reason = "Recipient accepted (and domain not Catch-All)";
        }
      }
    } catch (smtpErr) {
      results.reason = `SMTP Error: ${smtpErr.message}`;
    } finally {
      await client.quit();
    }
  } catch (err) {
    results.reason = `System Error: ${err.message}`;
  }

  return results;
}

// FIX: Only export the function, not the STATUS (since it's now external)
module.exports = {
  verifyEmail,
  STATUS, // Exporting it here too for backward compatibility if needed, but verifyEmail is the main one
};
