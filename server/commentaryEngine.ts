// generateCommentary.ts
import { Trigger } from "@/types/trigger";
import { WebhookPayload } from "@/types/webhook";
import { callClaude } from "./claudeClient"; // Your existing Claude wrapper
import { cacheNarrative } from "./cache";   // Optional caching module

export async function generateCommentary(
  trigger: Trigger,
  webhooks: WebhookPayload[],
  currentBias: string,
  currentScore: number,
  ictScore: number,
  confluences: string[],
  warnings: string[],
): Promise<void> {
  const latest = webhooks[0];
  if (!latest) return;

  // ── Cost Control: only call Claude for high-value commentary ─────────────
  const MIN_COMMENTARY_GAP_MS = 15 * 60 * 1000; // 15 minutes

  const hasStrongSetup = currentScore >= 70;
  const isHighUrgency = trigger.urgency === "high";
  const hasOrderFlow =
    latest.delta !== null ||
    latest.absorptionBull === 1 ||
    latest.absorptionBear === 1 ||
    latest.imbalanceBull === 1 ||
    latest.imbalanceBear === 1;

  // Skip Claude if low-score / low-urgency update
  if (!hasStrongSetup && !isHighUrgency) return;

  // Optional: skip if score < 60 and no order flow
  if (currentScore < 60 && !hasOrderFlow) return;

  // Throttle calls
  if (Date.now() - (trigger.lastCommentaryTs || 0) < MIN_COMMENTARY_GAP_MS) return;
  trigger.lastCommentaryTs = Date.now();

  // ── Prepare the prompt for Claude ─────────────────────────────────────────
  const prompt = `
Market Analysis:
Bias: ${currentBias}
Current Score: ${currentScore}
ICT Score: ${ictScore}
Confluences: ${confluences.join(", ")}
Warnings: ${warnings.join(", ")}
Volume/Order Flow:
Delta: ${latest.delta ?? "N/A"}
Absorption Bull: ${latest.absorptionBull}
Absorption Bear: ${latest.absorptionBear}
Imbalance Bull: ${latest.imbalanceBull}
Imbalance Bear: ${latest.imbalanceBear}
Bid Stack: ${latest.bidStackSize ?? "N/A"}
Ask Stack: ${latest.askStackSize ?? "N/A"}
`;

  // ── Call Claude (use lighter model to save cost) ─────────────────────────
  const narrative = await callClaude(prompt, {
    model: "claude-sonnet-4",
    max_tokens: 300,
  });

  // ── Optional: cache narrative to avoid duplicate calls ───────────────────
  await cacheNarrative(latest.id, narrative);

  // ── Output / store narrative in your DB or dashboard ─────────────────────
  console.log("Generated Commentary:", narrative);
}
