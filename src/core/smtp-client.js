/**
 * src/core/smtp-client.js
 * * Production-grade SMTP State Machine Client
 * Manages the conversation flow (EHLO -> MAIL FROM -> RCPT TO -> QUIT)
 * * 2025 Standards:
 * - Strict State Machine (no out-of-order commands)
 * - EHLO with HELO fallback strategy
 * - Randomized "Think Time" delays to evade heuristic filters
 * - Full parser integration
 * - RFC 5321 compliant MAIL FROM/RCPT TO syntax
 */

const { connectToSmtp, closeSocket } = require("./connection");
const { parseSmtpResponse, CLASSIFICATION } = require("./parser");
const constants = require("../config/constants");
const { sleep, randomDelay } = require("../utils/sleep");

/**
 * SMTP Session States
 */
const STATE = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTED: "CONNECTED", // TCP/Proxy connected, Banner received
  HELLO_SENT: "HELLO_SENT", // EHLO/HELO sent
  MAIL_FROM_SENT: "MAIL_FROM_SENT",
  RCPT_TO_SENT: "RCPT_TO_SENT",
  QUIT_SENT: "QUIT_SENT",
});

class SmtpClient {
  constructor(smtpHost, smtpPort, options = {}) {
    this.host = smtpHost;
    this.port = smtpPort;
    this.options = options;
    this.socket = null;
    this.state = STATE.DISCONNECTED;
    this.banner = null;
    this.features = []; // SMTP extensions (STARTTLS, SIZE, etc)
  }

  /**
   * Internal helper to write to socket with logging
   */
  async _write(command) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Socket not connected");
    }
    // console.log(`[Client] > ${command.trim()}`);
    return new Promise((resolve, reject) => {
      this.socket.write(command, "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Internal helper to read next response
   */
  async _readResponse() {
    return new Promise((resolve, reject) => {
      const onData = (data) => {
        clean();
        const raw = data.toString("utf8");
        // console.log(`[Server] < ${raw.trim()}`);
        const parsed = parseSmtpResponse(raw);
        if (parsed) resolve(parsed);
        else reject(new Error("Empty or invalid SMTP response"));
      };

      const onError = (err) => {
        clean();
        reject(err);
      };

      const clean = () => {
        this.socket.removeListener("data", onData);
        this.socket.removeListener("error", onError);
      };

      this.socket.on("data", onData);
      this.socket.once("error", onError);
    });
  }

  /**
   * Step 1: Connect and wait for Banner
   */
  async connect() {
    // 2025: Randomized initial delay before connecting (100-300ms)
    // await sleep(randomDelay(100, 300));

    const result = await connectToSmtp(this.host, this.port, this.options);
    if (!result.success) {
      throw result.error;
    }

    this.socket = result.socket;
    this.banner = result.banner;
    this.state = STATE.CONNECTED;
    return result;
  }

  /**
   * Step 2: Send Hello (EHLO with HELO fallback)
   */
  async sendHello(hostname = constants.SMTP.DEFAULT_HELO) {
    if (this.state !== STATE.CONNECTED)
      throw new Error("Must connect before sending HELLO");

    // Anti-Spam: Think time (100-500ms) before saying Hello
    await sleep(randomDelay(100, 500));

    // Try EHLO first
    await this._write(`EHLO ${hostname}\r\n`);
    this.state = STATE.HELLO_SENT;

    let response = await this._readResponse();

    // Fallback: If 500/501/502 (Command not recognized), try HELO
    if (response.code >= 500 && response.code <= 502) {
      console.log("[Client] ! EHLO failed, falling back to HELO...");
      await sleep(randomDelay(200, 400));
      await this._write(`HELO ${hostname}\r\n`);
      response = await this._readResponse();
    }

    if (response.classification !== CLASSIFICATION.SUCCESS) {
      throw new Error(`Handshake failed: ${response.code} ${response.message}`);
    }

    // Capture features from EHLO response lines
    if (response.lines.length > 1) {
      this.features = response.lines.slice(1).map((l) => l.substring(4).trim());
    }

    return response;
  }

  /**
   * Step 3: Send MAIL FROM (The Sender)
   */
  async sendMailFrom(senderEmail) {
    if (this.state !== STATE.HELLO_SENT)
      throw new Error("Must send HELLO before MAIL FROM");

    // Anti-Spam: Think time (150-800ms) - simulating processing
    await sleep(randomDelay(150, 800));

    // RFC 5321: Strict syntax "<email>"
    const cmd = `MAIL FROM:<${senderEmail}>\r\n`;
    await this._write(cmd);

    const response = await this._readResponse();

    if (response.classification !== CLASSIFICATION.SUCCESS) {
      throw new Error(`MAIL FROM failed: ${response.code} ${response.message}`);
    }

    this.state = STATE.MAIL_FROM_SENT;
    return response;
  }

  /**
   * Step 4: Send RCPT TO (The Verification Step)
   * UPDATED: Allows multiple RCPT TO calls (Pipelining support logic)
   */
  async sendRcptTo(recipientEmail) {
    // BUG FIX: Allow RCPT TO if state is MAIL_FROM_SENT OR already RCPT_TO_SENT
    if (
      this.state !== STATE.MAIL_FROM_SENT &&
      this.state !== STATE.RCPT_TO_SENT
    ) {
      throw new Error("Must send MAIL FROM before RCPT TO");
    }

    // Anti-Spam: Think time (100-600ms)
    await sleep(randomDelay(100, 600));

    // RFC 5321: Strict syntax "<email>"
    const cmd = `RCPT TO:<${recipientEmail}>\r\n`;
    await this._write(cmd);

    const response = await this._readResponse();
    this.state = STATE.RCPT_TO_SENT;

    return response;
  }

  /**
   * Step 5: Quit and Close
   */
  async quit() {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this._write("QUIT\r\n");
        this.state = STATE.QUIT_SENT;
        // We don't strictly need to wait for the 221 response, but it's polite
        // await this._readResponse();
      } catch (e) {
        // Ignore write errors during quit
      }
      await closeSocket(this.socket);
    }
    this.state = STATE.DISCONNECTED;
  }
}

module.exports = SmtpClient;
