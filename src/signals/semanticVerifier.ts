/**
 * Narrow semantic check: given a claim and the specific cited snippet(s),
 * does the content actually support the claim? This is intentionally the
 * ONLY piece of grounding verification that still uses a model call - and
 * it's scoped as small as possible (one claim + its own citations, not
 * the whole explanation) specifically so a free-tier model is
 * sufficient and cheap to run on every explanation.
 *
 * Uses Groq's OpenAI-compatible chat completions endpoint, free tier,
 * Llama 3.3 70B - fast and adequate for this narrow yes/no classification
 * task. Requires GROQ_API_KEY in env; if absent, this check is skipped
 * (returns null) rather than failing the whole pipeline - semantic
 * verification is a confidence-booster, not a hard requirement, since
 * structural grounding (real id, causally prior) already passed by the
 * time this runs.
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export async function verifyClaimSupportedByContent(
  claim: string,
  citedContent: string[]
): Promise<boolean | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn(
      "[semanticVerifier] GROQ_API_KEY not set - skipping semantic check"
    );
    return null;
  }
  if (citedContent.length === 0) return null; // nothing to check

  const prompt = `Claim: "${claim}"

Cited content:
${citedContent.map((c, i) => `[${i + 1}] ${c}`).join("\n")}

Does the cited content actually support this specific claim? Answer with
ONLY the single word YES or NO - no explanation, no punctuation.`;

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error(`[semanticVerifier] Groq API error: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const answer: string = data.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (answer.startsWith("YES")) return true;
    if (answer.startsWith("NO")) return false;

    console.warn(`[semanticVerifier] unexpected response: "${answer}"`);
    return null;
  } catch (err) {
    console.error("[semanticVerifier] request failed:", err);
    return null;
  }
}
