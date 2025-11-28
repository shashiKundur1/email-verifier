/**
 * src/core/dns.js
 * * Production-grade DNS MX record resolver using dns2 library
 * Handles failover, timeout, error classification, and result caching
 */

const DNS = require("dns2");
const { Packet } = DNS; // Extract Packet from the main export

// Go up one level (..) to reach the config folder
const constants = require("../config/constants");

/**
 * Configuration for DNS resolvers
 * We mix the Global Constants with specific logic for this module.
 */
const DNS_CONFIG = Object.freeze({
  // Use providers from constants if available, or default to Google
  PRIMARY_SERVERS: ["8.8.8.8", "8.8.4.4"],
  FALLBACK_SERVERS: ["1.1.1.1", "1.0.0.1"],
  SECONDARY_SERVERS: ["9.9.9.9", "149.112.112.112"],

  // Use the global timeout from Phase 1
  QUERY_TIMEOUT: constants.TIMEOUTS.DNS_LOOKUP || 5000,

  MAX_RETRIES: 2,
  RETRY_DELAY_BASE: 500,
});

/**
 * Error classification constants
 */
const ERROR_TYPES = Object.freeze({
  HARD_FAIL: "HARD_FAIL", // Domain doesn't exist, don't retry
  SOFT_FAIL: "SOFT_FAIL", // Transient DNS error, retry
  TIMEOUT: "TIMEOUT", // Query timed out, retry
  NO_MX_RECORDS: "NO_MX_RECORDS", // Domain exists but no MX records
  INVALID_DOMAIN: "INVALID_DOMAIN", // Malformed domain
});

/**
 * Initialize DNS resolver with specified servers and timeout
 * @param {string[]} nameServers - Array of DNS server IPs
 * @param {number} timeout - Query timeout in milliseconds
 * @returns {Object} DNS resolver instance
 */
function createResolver(
  nameServers = DNS_CONFIG.PRIMARY_SERVERS,
  timeout = DNS_CONFIG.QUERY_TIMEOUT
) {
  try {
    // Corrected instantiation for dns2 v2.x
    const resolver = new DNS({
      nameServers: nameServers,
      timeout: timeout,
    });
    return resolver;
  } catch (err) {
    console.error("[DNS] Failed to create resolver:", err.message);
    throw new Error(`DNS resolver initialization failed: ${err.message}`);
  }
}

/**
 * Classify DNS error for retry decision
 * @param {Error} err - Error object from DNS query
 * @returns {string} Error type from ERROR_TYPES
 */
function classifyError(err) {
  const message = err.message || "";
  const code = err.code || "";

  if (
    code === "ETIMEDOUT" ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) {
    return ERROR_TYPES.TIMEOUT;
  }
  if (
    code === "ENOTFOUND" ||
    message.includes("NXDOMAIN") ||
    message.includes("non-existent")
  ) {
    return ERROR_TYPES.HARD_FAIL;
  }
  if (code === "ECONNREFUSED" || message.includes("refused")) {
    return ERROR_TYPES.SOFT_FAIL;
  }
  if (
    code === "SERVFAIL" ||
    message.includes("server failure") ||
    message.includes("500")
  ) {
    return ERROR_TYPES.SOFT_FAIL;
  }
  if (code === "EINVAL" || message.includes("invalid")) {
    return ERROR_TYPES.INVALID_DOMAIN;
  }
  return ERROR_TYPES.SOFT_FAIL;
}

/**
 * Sort MX records by priority (lowest = highest priority, tried first)
 * @param {Array} mxRecords - Array of MX record objects {exchange, priority}
 * @returns {Array} Sorted MX records (lowest priority first)
 */
function sortMXByPriority(mxRecords) {
  if (!Array.isArray(mxRecords) || mxRecords.length === 0) {
    return [];
  }
  return mxRecords.sort((a, b) => {
    const priorityA = parseInt(a.priority, 10) || 65535;
    const priorityB = parseInt(b.priority, 10) || 65535;
    return priorityA - priorityB;
  });
}

/**
 * Validate domain format (basic check)
 * @param {string} domain - Domain to validate
 * @returns {boolean} True if domain format is valid
 */
function isValidDomain(domain) {
  const domainRegex =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]{2,}$/i;
  return (
    typeof domain === "string" &&
    domain.length > 0 &&
    domain.length <= 253 &&
    domainRegex.test(domain)
  );
}

/**
 * Query MX records with retry logic and error handling
 * @param {string} domain - Domain to query
 * @param {Object} options - Configuration options
 * @returns {Promise<Array>} Sorted MX records or empty array
 */
async function resolveMX(domain, options = {}) {
  const {
    nameServers = DNS_CONFIG.PRIMARY_SERVERS,
    timeout = DNS_CONFIG.QUERY_TIMEOUT,
    retries = DNS_CONFIG.MAX_RETRIES,
  } = options;

  if (!isValidDomain(domain)) {
    const error = new Error(`Invalid domain format: "${domain}"`);
    error.type = ERROR_TYPES.INVALID_DOMAIN;
    error.code = "EINVAL";
    throw error;
  }

  let lastError = null;
  let attempt = 0;
  const maxAttempts = retries + 1;

  while (attempt < maxAttempts) {
    try {
      const resolver = createResolver(nameServers, timeout);

      const promise = resolver.resolve(domain, "MX");
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DNS query timeout")), timeout)
      );

      const result = await Promise.race([promise, timeoutPromise]);

      if (!result || !result.answers || result.answers.length === 0) {
        const error = new Error(`No MX records found for domain: "${domain}"`);
        error.type = ERROR_TYPES.NO_MX_RECORDS;
        error.code = "ENODATA";
        throw error;
      }

      const mxRecords = result.answers
        .filter(
          (answer) => answer.type === Packet.TYPE.MX || answer.type === 15
        )
        .map((answer) => ({
          exchange: answer.exchange || answer.data?.exchange || "",
          priority: answer.priority ?? answer.data?.priority ?? 65535,
        }))
        .filter((mx) => mx.exchange);

      if (mxRecords.length === 0) {
        const error = new Error(
          `No valid MX records found for domain: "${domain}"`
        );
        error.type = ERROR_TYPES.NO_MX_RECORDS;
        error.code = "ENODATA";
        throw error;
      }

      return sortMXByPriority(mxRecords);
    } catch (err) {
      lastError = err;
      const errorType = classifyError(err);
      const isHardFail =
        errorType === ERROR_TYPES.HARD_FAIL ||
        errorType === ERROR_TYPES.INVALID_DOMAIN ||
        errorType === ERROR_TYPES.NO_MX_RECORDS;

      console.warn(
        `[DNS] ✗ Query failed for "${domain}" (type: ${errorType}, attempt ${
          attempt + 1
        }/${maxAttempts}): ${err.message}`
      );

      if (isHardFail) {
        err.type = errorType;
        err.code = err.code || "EDNS_HARD_FAIL";
        throw err;
      }

      attempt++;
      if (attempt < maxAttempts) {
        const delay = DNS_CONFIG.RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  lastError.type = ERROR_TYPES.SOFT_FAIL;
  lastError.code = lastError.code || "EDNS_RETRIES_EXHAUSTED";
  lastError.attempts = maxAttempts;
  throw lastError;
}

/**
 * Query MX records with fallback to alternate DNS servers
 */
async function resolveMXWithFallback(domain, options = {}) {
  const resolverChain = [
    DNS_CONFIG.PRIMARY_SERVERS,
    DNS_CONFIG.FALLBACK_SERVERS,
    DNS_CONFIG.SECONDARY_SERVERS,
  ];

  let lastError = null;

  for (let i = 0; i < resolverChain.length; i++) {
    try {
      return await resolveMX(domain, {
        nameServers: resolverChain[i],
        timeout: DNS_CONFIG.QUERY_TIMEOUT,
        retries: DNS_CONFIG.MAX_RETRIES,
        ...options,
      });
    } catch (err) {
      lastError = err;
      const isHardFail =
        err.type === ERROR_TYPES.HARD_FAIL ||
        err.type === ERROR_TYPES.INVALID_DOMAIN;

      if (isHardFail) {
        console.error(
          `[DNS] Hard failure (${err.type}), stopping resolver chain`
        );
        throw err;
      }
      console.warn(
        `[DNS] Resolver ${i + 1} failed (${err.type}), trying next...`
      );
    }
  }

  const error = new Error(
    `MX resolution failed across all DNS servers for "${domain}"`
  );
  error.type = ERROR_TYPES.SOFT_FAIL;
  error.code = "EDNS_ALL_RESOLVERS_FAILED";
  error.originalError = lastError;
  throw error;
}

/**
 * Get MX records for domain with full error context
 */
async function getMXRecords(domain, options = {}) {
  try {
    const records = await resolveMXWithFallback(domain, options);
    return {
      success: true,
      domain,
      records,
      recordCount: records.length,
      error: null,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      domain,
      records: [],
      recordCount: 0,
      error: {
        message: err.message,
        type: err.type || "UNKNOWN",
        code: err.code || "UNKNOWN",
        attempts: err.attempts || 1,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = {
  resolveMX,
  resolveMXWithFallback,
  getMXRecords,
  sortMXByPriority,
  isValidDomain,
  classifyError,
  createResolver,
  DNS_CONFIG,
  ERROR_TYPES,
};
