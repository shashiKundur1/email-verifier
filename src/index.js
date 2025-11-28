const { parseSmtpResponse } = require("./core/parser");

async function main() {
  console.log("--- Email Verifier Backend (Phase 5 Test: Parser) ---");

  const testCases = [
    {
      name: "Simple Success",
      raw: "250 OK\r\n",
    },
    {
      name: "Multi-line EHLO (Google Style)",
      raw: "250-mx.google.com at your service\r\n250-SIZE 35882577\r\n250-8BITMIME\r\n250-STARTTLS\r\n250-ENHANCEDSTATUSCODES\r\n250 CHUNKING\r\n",
    },
    {
      name: "Permanent Failure with Enhanced Code",
      raw: "550 5.1.1 The email account that you tried to reach does not exist.\r\n",
    },
    {
      name: "Incomplete Buffer (Should return null)",
      raw: "250-mx.google.com at your service\r\n250-SIZE 35882577\r\n",
    },
  ];

  testCases.forEach((test, index) => {
    console.log(`\nTest ${index + 1}: ${test.name}`);
    const result = parseSmtpResponse(test.raw);

    if (result) {
      console.log(
        `   ✅ Parsed: Code ${result.code} (${result.classification})`
      );
      if (result.enhancedCode)
        console.log(`      Enhanced Code: ${result.enhancedCode}`);
      console.log(`      Message: "${result.message.substring(0, 50)}..."`);
      console.log(`      Lines: ${result.lines.length}`);
    } else {
      console.log(
        `   ⚠️ Result: Incomplete/Null (Expected for incomplete buffer)`
      );
    }
  });
}

main().catch(console.error);
