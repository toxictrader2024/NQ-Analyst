// generateCommentary.ts
import { Trigger } from "@/types/trigger";
import { WebhookPayload } from "@/types/webhook";
import { callClaude } from "./claudeClient"; // Your existing Claude wrapper
import { cacheNarrative } from "./cache";   // Optional caching module

const MIN_COMMENTARY_GAP_MS = 15 * 60 * 1000; // 15-minute interval

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

  // ── Claude Cost Control ───────────────────────────────
  const hasStrongSetup = currentScore >= 70;
  const isHighUrgency = trigger.urgency === "high";
  const hasOrderFlow =
    (latest as any).delta !== null ||
    (latest as any).delta !== undefined ||
    (latest as any).absorptionBull === 1 ||
    (latest as any).absorptionBear === 1 ||
    (latest as any).imbalanceBull === 1 ||
    (latest as any).imbalanceBear === 1;

  if (!hasStrongSetup && !isHighUrgency) return;
  if (currentScore < 60 && !hasOrderFlow) return;

  // ── Throttle calls ────────────────────────────────────
  if (Date.now() - (trigger.lastCommentaryTs || 0) < MIN_COMMENTARY_GAP_MS) return;
  trigger.lastCommentaryTs = Date.now();

  // ── Prepare the prompt for Claude ─────────────────────
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

  // ── Call Claude ───────────────────────────────────────
  const narrative = await callClaude(prompt, {
    model: "claude-sonnet-4",
    max_tokens: 300,
  });

  // ── Cache narrative to avoid duplicate calls ──────────
  await cacheNarrative(latest.id, narrative);

  // ── Output / store narrative ─────────────────────────
  console.log("Generated Commentary:", narrative);
}
