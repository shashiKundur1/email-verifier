const path = require("path");

/**
 * Global Application Constants
 * Frozen to prevent runtime mutation.
 */
module.exports = Object.freeze({
  // Network Timeouts (in milliseconds)
  TIMEOUTS: Object.freeze({
    DNS_LOOKUP: 5000,
    TCP_CONNECT: 5000,
    SMTP_RESPONSE: 10000,
    CONNECTION_LIFETIME: 30000,
  }),

  // SMTP Configuration
  SMTP: Object.freeze({
    PORT: 25,
    // Standard "Think Time" delays to mimic human behavior (ms)
    MIN_DELAY: 100,
    MAX_DELAY: 800,
    // Default HELO hostname if none provided
    DEFAULT_HELO: "verify.example.com",
  }),

  // DNS Configuration
  DNS: Object.freeze({
    // Native Node.js lookup can be unreliable/hijacked by ISPs.
    // We prefer direct queries to root servers.
    PROVIDERS: [
      { ip: "1.1.1.1", port: 53 }, // Cloudflare
      { ip: "8.8.8.8", port: 53 }, // Google
    ],
  }),
});
