/**
 * src/core/connection.js
 * * Production-grade SMTP connection handler with SOCKS5 proxy support
 * Manages socket lifecycle, banner handling, and encoded communication
 * * 2025 Standards:
 * - Async/await with explicit error handling
 * - Separate timeouts: proxy handshake (10s) vs SMTP phase (5s)
 * - SOCKS5 auth error classification (distinguish proxy vs target failures)
 * - UTF-8 encoding (ASCII-compatible) for SMTP handshake
 * - Graceful socket closure with proper cleanup
 */

const net = require("net");
const { SocksClient } = require("socks");

/**
 * Configuration for connection handling
 */
const CONNECTION_CONFIG = Object.freeze({
  // SMTP connection timeouts (phases separate from proxy)
  SMTP_BANNER_TIMEOUT: 5000, // Time to receive 220 banner
  SMTP_COMMAND_TIMEOUT: 5000, // Time per SMTP command (EHLO, MAIL FROM, etc)
  SMTP_SOCKET_TIMEOUT: 5000, // Fallback socket timeout

  // Proxy handshake timeouts (includes auth)
  PROXY_HANDSHAKE_TIMEOUT: 10000, // Time to complete SOCKS5 handshake

  // Socket encoding
  SOCKET_ENCODING: "utf8", // UTF-8 (backward compatible with ASCII)

  // Banner validation
  SMTP_BANNER_CODE: "220", // Expected banner code
  SMTP_BANNER_REGEX: /^220[\s\-]/, // RFC 5321: "220 " or "220-"

  // Graceful closure
  CLOSE_TIMEOUT: 1000, // Wait for graceful close before destroy
});

/**
 * Error types for connection failures
 */
const CONNECTION_ERROR_TYPES = Object.freeze({
  // Proxy-related errors
  PROXY_AUTH_FAILED: "PROXY_AUTH_FAILED",
  PROXY_HANDSHAKE_TIMEOUT: "PROXY_HANDSHAKE_TIMEOUT",
  PROXY_CONNECTION_FAILED: "PROXY_CONNECTION_FAILED",

  // SMTP-related errors
  SMTP_BANNER_TIMEOUT: "SMTP_BANNER_TIMEOUT",
  SMTP_BANNER_INVALID: "SMTP_BANNER_INVALID",
  SMTP_CONNECTION_FAILED: "SMTP_CONNECTION_FAILED",
  SMTP_SOCKET_ERROR: "SMTP_SOCKET_ERROR",

  // General errors
  SOCKET_TIMEOUT: "SOCKET_TIMEOUT",
  SOCKET_DESTROYED: "SOCKET_DESTROYED",
  INVALID_CONFIG: "INVALID_CONFIG",
});

/**
 * Classify SOCKS5 error codes to determine phase and severity
 */
function classifySocksError(socksCode) {
  const codeMap = {
    0x00: {
      phase: "none",
      type: "SUCCESS",
      description: "Connection succeeded",
      retryable: false,
    },
    0x01: {
      phase: "proxy",
      type: "GENERAL_FAILURE",
      description: "General SOCKS server failure",
      retryable: true,
    },
    0x02: {
      phase: "proxy",
      type: "RULESET_VIOLATION",
      description: "Connection not allowed by ruleset (auth/ACL)",
      retryable: false,
    },
    0x03: {
      phase: "target",
      type: "NETWORK_UNREACHABLE",
      description: "Network unreachable",
      retryable: false,
    },
    0x04: {
      phase: "target",
      type: "HOST_UNREACHABLE",
      description: "Host unreachable",
      retryable: false,
    },
    0x05: {
      phase: "target",
      type: "CONNECTION_REFUSED",
      description: "Connection refused by remote host",
      retryable: false,
    },
    0x06: {
      phase: "target",
      type: "TTL_EXPIRED",
      description: "TTL expired",
      retryable: false,
    },
    0x07: {
      phase: "proxy",
      type: "COMMAND_NOT_SUPPORTED",
      description: "Command not supported",
      retryable: false,
    },
    0x08: {
      phase: "proxy",
      type: "ADDRESS_TYPE_NOT_SUPPORTED",
      description: "Address type not supported",
      retryable: false,
    },
    0xff: {
      phase: "proxy",
      type: "NO_AUTH_METHODS",
      description: "No acceptable authentication methods",
      retryable: false,
    },
  };

  return (
    codeMap[socksCode] || {
      phase: "unknown",
      type: "UNKNOWN_ERROR",
      description: `Unknown SOCKS error code: 0x${socksCode
        .toString(16)
        .toUpperCase()}`,
      retryable: true,
    }
  );
}

/**
 * Extract SOCKS5 response code from error message
 */
function extractSocksCode(err) {
  if (typeof err.socksResponseCode === "number") {
    return err.socksResponseCode;
  }
  const match = err.message?.match(/code\s+0x([0-9a-fA-F]{2})/i);
  if (match) {
    return parseInt(match[1], 16);
  }
  return null;
}

/**
 * Validate SMTP banner response
 */
function validateSmtpBanner(banner) {
  if (!banner || typeof banner !== "string") {
    return {
      valid: false,
      code: null,
      message: "Empty or invalid banner",
      raw: String(banner),
    };
  }

  const trimmed = banner.trim();
  const match = trimmed.match(/^(\d{3})([\s\-])(.*)/);

  if (!match) {
    return {
      valid: false,
      code: null,
      message: 'Invalid banner format (expected "XXX message")',
      raw: trimmed.slice(0, 100), // Truncate for logging
    };
  }

  const [, code, separator, message] = match;

  if (code !== CONNECTION_CONFIG.SMTP_BANNER_CODE) {
    return {
      valid: false,
      code,
      message: `Expected code ${CONNECTION_CONFIG.SMTP_BANNER_CODE}, received ${code}`,
      raw: trimmed,
    };
  }

  return {
    valid: true,
    code,
    message: message || "(no message)",
    raw: trimmed,
  };
}

/**
 * Create a direct TCP connection to SMTP server (no proxy)
 */
async function createDirectConnection(host, port, options = {}) {
  const { timeout = CONNECTION_CONFIG.SMTP_SOCKET_TIMEOUT } = options;

  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    let resolved = false;

    try {
      const socket = net.createConnection({ host, port });

      // Set encoding immediately after socket creation
      socket.setEncoding(CONNECTION_CONFIG.SOCKET_ENCODING);

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        socket.removeAllListeners("connect");
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
      };

      socket.once("connect", () => {
        cleanup();
        if (!resolved) {
          resolved = true;
          // console.log(`[Connection] ✓ Direct TCP connection established to ${host}:${port}`);
          resolve(socket);
        }
      });

      socket.once("error", (err) => {
        cleanup();
        if (!resolved) {
          resolved = true;
          err.type = CONNECTION_ERROR_TYPES.SMTP_CONNECTION_FAILED;
          err.code = err.code || "ECONNFAILED";
          console.error(
            `[Connection] ✗ Direct connection error: ${err.message}`
          );
          reject(err);
        }
      });

      socket.once("timeout", () => {
        cleanup();
        if (!resolved) {
          resolved = true;
          const err = new Error(`Direct connection timeout after ${timeout}ms`);
          err.type = CONNECTION_ERROR_TYPES.SOCKET_TIMEOUT;
          err.code = "ETIMEDOUT";
          console.error(`[Connection] ✗ ${err.message}`);
          reject(err);
        }
      });

      // Set timeout handler
      socket.setTimeout(timeout);

      // Connection timeout backup
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          const err = new Error(`Connection timeout after ${timeout}ms`);
          err.type = CONNECTION_ERROR_TYPES.SOCKET_TIMEOUT;
          err.code = "ETIMEDOUT";
          console.error(`[Connection] ✗ ${err.message}`);
          reject(err);
        }
      }, timeout + 500);
    } catch (err) {
      if (!resolved) {
        resolved = true;
        err.type = CONNECTION_ERROR_TYPES.INVALID_CONFIG;
        reject(err);
      }
    }
  });
}

/**
 * Create a SOCKS5 proxy connection to SMTP server
 */
async function createProxyConnection(
  proxyConfig,
  smtpHost,
  smtpPort,
  options = {}
) {
  const { proxyTimeout = CONNECTION_CONFIG.PROXY_HANDSHAKE_TIMEOUT } = options;

  // Build SOCKS options
  const socksOptions = {
    proxy: {
      host: proxyConfig.host,
      port: proxyConfig.port,
      type: 5, // SOCKS5
      ...(proxyConfig.username && { username: proxyConfig.username }),
      ...(proxyConfig.password && { password: proxyConfig.password }),
    },
    command: "connect",
    destination: {
      host: smtpHost,
      port: smtpPort,
    },
  };

  console.log(
    `[Connection] Initiating SOCKS5 connection via ${proxyConfig.host}:${proxyConfig.port} to ${smtpHost}:${smtpPort}...`
  );

  return new Promise((resolve, reject) => {
    let resolved = false;

    try {
      // Proxy handshake with timeout (includes auth)
      const proxyPromise = SocksClient.createConnection(socksOptions);

      const timeoutPromise = new Promise((_, timeoutReject) =>
        setTimeout(() => {
          timeoutReject(new Error("SOCKS5 proxy handshake timeout"));
        }, proxyTimeout)
      );

      Promise.race([proxyPromise, timeoutPromise])
        .then((info) => {
          if (!resolved) {
            resolved = true;
            const socket = info.socket;
            socket.setEncoding(CONNECTION_CONFIG.SOCKET_ENCODING);
            console.log(`[Connection] ✓ SOCKS5 proxy connection established`);
            resolve(socket);
          }
        })
        .catch((err) => {
          if (!resolved) {
            resolved = true;

            // Classify SOCKS error
            const socksCode = extractSocksCode(err);
            let errorType = CONNECTION_ERROR_TYPES.PROXY_CONNECTION_FAILED;
            let errorPhase = "proxy";

            if (
              err.message?.includes("timeout") ||
              err.message?.includes("timed out")
            ) {
              errorType = CONNECTION_ERROR_TYPES.PROXY_HANDSHAKE_TIMEOUT;
            } else if (socksCode !== null) {
              const classification = classifySocksError(socksCode);
              errorPhase = classification.phase;
              errorType =
                errorPhase === "proxy"
                  ? CONNECTION_ERROR_TYPES.PROXY_AUTH_FAILED
                  : CONNECTION_ERROR_TYPES.SMTP_CONNECTION_FAILED;

              console.error(
                `[Connection] ✗ SOCKS error (phase: ${errorPhase}, code: 0x${socksCode
                  .toString(16)
                  .toUpperCase()}): ${classification.description}`
              );
            }

            err.type = errorType;
            err.socksErrorPhase = errorPhase;
            err.socksCode = socksCode;
            reject(err);
          }
        });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        err.type = CONNECTION_ERROR_TYPES.INVALID_CONFIG;
        reject(err);
      }
    }
  });
}

/**
 * Receive and validate SMTP banner (220 response)
 */
async function receiveBanner(socket, options = {}) {
  const { timeout = CONNECTION_CONFIG.SMTP_BANNER_TIMEOUT } = options;

  return new Promise((resolve, reject) => {
    let resolved = false;
    let timeoutHandle = null;
    let dataBuffer = "";

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("timeout");
    };

    socket.once("data", (chunk) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        dataBuffer += chunk.toString(CONNECTION_CONFIG.SOCKET_ENCODING);
        const banner = dataBuffer.trim();
        // console.log(`[Connection] Banner received: ${banner.slice(0, 100)}`);

        const validation = validateSmtpBanner(banner);

        if (!validation.valid) {
          const err = new Error(`Invalid SMTP banner: ${validation.message}`);
          err.type = CONNECTION_ERROR_TYPES.SMTP_BANNER_INVALID;
          err.code = "EBANNER_INVALID";
          err.banner = validation.raw;
          reject(err);
        } else {
          resolve({
            valid: true,
            banner: validation.raw,
            code: validation.code,
            message: validation.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    socket.once("error", (err) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        err.type = CONNECTION_ERROR_TYPES.SMTP_SOCKET_ERROR;
        reject(err);
      }
    });

    socket.once("timeout", () => {
      cleanup();
      if (!resolved) {
        resolved = true;
        const err = new Error(`SMTP banner timeout after ${timeout}ms`);
        err.type = CONNECTION_ERROR_TYPES.SMTP_BANNER_TIMEOUT;
        err.code = "EBANNER_TIMEOUT";
        socket.destroy();
        reject(err);
      }
    });

    socket.setTimeout(timeout);

    // Backup timeout
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        const err = new Error(`Banner timeout after ${timeout}ms`);
        err.type = CONNECTION_ERROR_TYPES.SMTP_BANNER_TIMEOUT;
        err.code = "EBANNER_TIMEOUT";
        reject(err);
      }
    }, timeout + 500);
  });
}

/**
 * Close socket gracefully with cleanup
 */
async function closeSocket(socket, options = {}) {
  const { timeout = CONNECTION_CONFIG.CLOSE_TIMEOUT } = options;

  return new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      resolve();
      return;
    }

    let closeTimer = null;
    const forceDestroy = () => {
      if (closeTimer) clearTimeout(closeTimer);
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve();
    };

    socket.once("end", forceDestroy);
    socket.once("close", forceDestroy);
    socket.once("error", forceDestroy);

    closeTimer = setTimeout(forceDestroy, timeout);

    try {
      socket.end(); // Graceful close (FIN)
    } catch (err) {
      console.warn(`[Connection] Warning during socket.end(): ${err.message}`);
      forceDestroy();
    }
  });
}

/**
 * Establish SMTP connection (direct or via proxy) and receive banner
 */
async function connectToSmtp(smtpHost, smtpPort, options = {}) {
  const { proxy } = options;
  let socket = null;

  try {
    // Step 1: Establish connection (direct or proxy)
    if (proxy) {
      socket = await createProxyConnection(proxy, smtpHost, smtpPort, options);
    } else {
      socket = await createDirectConnection(smtpHost, smtpPort, options);
    }

    // Step 2: Receive and validate banner (separate timeout from connection)
    const bannerInfo = await receiveBanner(socket, options);

    // console.log(`[Connection] ✓ Connected to SMTP server ${smtpHost}:${smtpPort}${proxy ? ' (via proxy)' : ''}`);

    return {
      success: true,
      socket,
      banner: bannerInfo.banner,
      bannerCode: bannerInfo.code,
      bannerMessage: bannerInfo.message,
      proxyUsed: !!proxy,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Cleanup socket if connection/banner failed
    if (socket && !socket.destroyed) {
      await closeSocket(socket);
    }

    return {
      success: false,
      socket: null,
      error: {
        message: err.message,
        type: err.type || "UNKNOWN_ERROR",
        code: err.code || "UNKNOWN",
        socksCode: err.socksCode || null,
        socksErrorPhase: err.socksErrorPhase || null,
        banner: err.banner || null,
      },
      proxyUsed: !!proxy,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = {
  connectToSmtp,
  createDirectConnection,
  createProxyConnection,
  receiveBanner,
  validateSmtpBanner,
  closeSocket,
  classifySocksError,
  extractSocksCode,
  CONNECTION_CONFIG,
  CONNECTION_ERROR_TYPES,
};
