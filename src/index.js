/**
 * src/index.js
 * Main Entry Point for Email Verifier CLI
 */

const { verifyEmail } = require("./core/verifier");
const { formatOutput } = require("./utils/mapper");

async function main() {
  // 1. Parse CLI Arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node src/index.js <email>");
    process.exit(1);
  }

  const targetEmail = args[0];

  // 2. Run Verification
  // console.log(`Verifying: ${targetEmail}...`);

  try {
    const internalResult = await verifyEmail(targetEmail, {
      senderEmail: "verify@example.com", // Replace with your domain in production
      helo: "example.com",
    });

    // 3. Format Output
    const jsonOutput = formatOutput(internalResult);

    // 4. Print JSON (Pure JSON for piping)
    console.log(JSON.stringify(jsonOutput, null, 2));
  } catch (err) {
    // Fallback JSON for catastrophic errors
    console.log(
      JSON.stringify(
        {
          error: err.message,
          can_connect_smtp: false,
          is_deliverable: false,
        },
        null,
        2
      )
    );
  }
}

main();
