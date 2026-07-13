/**
 * Standalone CLI to instantly flip a feature flag - the actual "stop
 * spending money right now" tool. Doesn't touch any deployed service,
 * doesn't require a redeploy - just writes directly to the same
 * Firestore doc every service reads (system_config/feature_flags),
 * which takes effect within the 15s cache TTL (see
 * src/config/featureFlags.ts).
 *
 * Usage:
 *   npx tsx src/scripts/toggleFlag.ts pipeline_enabled off   # STOP EVERYTHING
 *   npx tsx src/scripts/toggleFlag.ts pipeline_enabled on
 *   npx tsx src/scripts/toggleFlag.ts claude_enabled off     # keep detecting/fetching, stop Claude calls only
 *   npx tsx src/scripts/toggleFlag.ts tiingo_enabled off
 *   npx tsx src/scripts/toggleFlag.ts adanos_enabled off
 *   npx tsx src/scripts/toggleFlag.ts groq_enabled off
 *   npx tsx src/scripts/toggleFlag.ts status                 # show current state of all flags
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointed at a service account
 * with Firestore write access - same credential the deployed services
 * use, see .env.example.
 */
import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";

const VALID_FLAGS = [
  "pipeline_enabled",
  "claude_enabled",
  "tiingo_enabled",
  "adanos_enabled",
  "groq_enabled",
] as const;

async function main() {
  const db = new Firestore();
  const docRef = db.collection("system_config").doc("feature_flags");

  const [flag, value] = process.argv.slice(2);

  if (!flag || flag === "status") {
    const doc = await docRef.get();
    const current = doc.exists ? doc.data() : {};
    console.log("Current feature flags (missing = defaults to enabled):");
    for (const f of VALID_FLAGS) {
      const state = current?.[f] === false ? "OFF" : "on (default)";
      console.log(`  ${f}: ${state}`);
    }
    return;
  }

  if (!VALID_FLAGS.includes(flag as (typeof VALID_FLAGS)[number])) {
    console.error(`Unknown flag "${flag}". Valid flags: ${VALID_FLAGS.join(", ")}`);
    process.exit(1);
  }

  if (value !== "on" && value !== "off") {
    console.error(`Usage: toggleFlag.ts <flag> <on|off>, or toggleFlag.ts status`);
    process.exit(1);
  }

  await docRef.set({ [flag]: value === "on" }, { merge: true });
  console.log(`✓ ${flag} set to ${value === "on" ? "ENABLED" : "DISABLED"}`);
  console.log("Takes effect within ~15 seconds (feature flag cache TTL).");
}

main().catch((err) => {
  console.error("Failed to toggle flag:", err);
  process.exit(1);
});
