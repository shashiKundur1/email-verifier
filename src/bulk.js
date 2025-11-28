/**
 * src/bulk.js
 * * Bulk Email Verifier
 * * Process 1000s of emails with concurrency control.
 */

const fs = require("fs");
const { verifyEmail } = require("./core/verifier");
const { formatOutput } = require("./utils/mapper");

// CONCURRENCY LIMIT: How many checks to run at the SAME time.
// Keep this under 50 to avoid network congestion.
const BATCH_SIZE = 20;

async function processBatch(emails) {
  const promises = emails.map(async (email) => {
    try {
      // Run verification
      const result = await verifyEmail(email.trim(), {
        senderEmail: "verify@example.com",
        helo: "example.com",
      });
      return { email, ...formatOutput(result) };
    } catch (e) {
      return { email, error: e.message };
    }
  });

  return Promise.all(promises);
}

async function main() {
  // 1. Load Emails
  const inputFile = process.argv[2] || "emails.txt";
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: File ${inputFile} not found.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputFile, "utf-8");
  const allEmails = raw.split("\n").filter((e) => e.trim().includes("@")); // Simple filter

  console.log(`Loading ${allEmails.length} emails...`);
  console.log(`Batch Size: ${BATCH_SIZE} concurrent connections`);
  console.log("------------------------------------------------");

  const finalResults = [];
  const startTime = Date.now();

  // 2. Process in Chunks
  for (let i = 0; i < allEmails.length; i += BATCH_SIZE) {
    const chunk = allEmails.slice(i, i + BATCH_SIZE);

    console.log(
      `Processing batch ${i + 1} to ${Math.min(
        i + BATCH_SIZE,
        allEmails.length
      )}...`
    );

    // Run this chunk in PARALLEL
    const batchResults = await processBatch(chunk);
    finalResults.push(...batchResults);
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;

  // 3. Save Results
  fs.writeFileSync("results.json", JSON.stringify(finalResults, null, 2));

  console.log("------------------------------------------------");
  console.log(
    `✅ Done! Processed ${allEmails.length} emails in ${duration.toFixed(2)}s.`
  );
  console.log(
    `🚀 Average Speed: ${(allEmails.length / duration).toFixed(2)} emails/sec`
  );
  console.log(`📁 Results saved to results.json`);
}

main();
