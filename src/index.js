const constants = require("./config/constants");
const { getMXRecords } = require("./core/dns");
const { connectToSmtp, closeSocket } = require("./core/connection");

async function main() {
  console.log("--- Email Verifier Backend (Phase 4 Test: SOCKS5 Logic) ---");

  const targetDomain = "gmail.com";

  try {
    // 1. Get MX
    const mxResult = await getMXRecords(targetDomain);
    const topMx = mxResult.records[0];

    // Test 1: Direct Connection (Should Work)
    console.log(`\n1. Testing DIRECT connection to ${topMx.exchange}...`);
    const directResult = await connectToSmtp(topMx.exchange, 25);

    if (directResult.success) {
      console.log(`   ✅ Direct Success: ${directResult.banner}`);
      await closeSocket(directResult.socket);
    } else {
      console.log(`   ❌ Direct Failed: ${directResult.error.message}`);
    }

    // Test 2: Proxy Connection (Should Fail Gracefully if no proxy exists)
    // We will simulate a fake local proxy to trigger a connection refused error
    console.log(`\n2. Testing PROXY connection (Simulating 127.0.0.1:9050)...`);
    const proxyConfig = {
      host: "127.0.0.1",
      port: 9050, // Common Tor port (likely closed)
    };

    const proxyResult = await connectToSmtp(topMx.exchange, 25, {
      proxy: proxyConfig,
    });

    if (proxyResult.success) {
      console.log(`   ✅ Proxy Success: ${proxyResult.banner}`);
      await closeSocket(proxyResult.socket);
    } else {
      console.log(`   ✅ Proxy Failed Gracefully (Expected):`);
      console.log(`      Message: ${proxyResult.error.message}`);
      console.log(`      Type: ${proxyResult.error.type}`);
    }
  } catch (err) {
    console.error(err);
  }
}

main().catch(console.error);
