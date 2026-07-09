import { prisma } from '../config/database';

/**
 * Split-test allocation and response tracking. The AI creates experiments with
 * message variants, asks which variant to send next (explore/exploit), and the
 * platform records sends and — when a lead replies — responses, so the AI can
 * see which outreach actually works.
 */

export interface VariantResult {
  id: string;
  label: string;
  content: string;
  sends: number;
  responses: number;
  positiveResponses: number;
  responseRate: number;
}

export function summarizeVariant(v: {
  id: string;
  label: string;
  content: string;
  sends: number;
  responses: number;
  positiveResponses: number;
}): VariantResult {
  return {
    id: v.id,
    label: v.label,
    content: v.content,
    sends: v.sends,
    responses: v.responses,
    positiveResponses: v.positiveResponses,
    responseRate: v.sends > 0 ? v.responses / v.sends : 0,
  };
}

/**
 * Pick the next variant to send. Epsilon-greedy: while any variant is
 * under-sampled (< MIN_SAMPLES), send the least-sent one (explore); once all
 * are sampled, mostly exploit the best response rate but occasionally explore.
 */
const MIN_SAMPLES = 8;
const EXPLORE_RATE = 0.2;

export async function pickVariant(experimentId: string, organizationId: string) {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, organizationId, status: 'ACTIVE' },
    include: { variants: true },
  });
  if (!experiment) return null;
  const variants = experiment.variants;
  if (variants.length === 0) return null;

  const underSampled = variants.filter((v) => v.sends < MIN_SAMPLES);
  let chosen;
  if (underSampled.length > 0) {
    // Explore: least-sent under-sampled variant
    chosen = underSampled.reduce((a, b) => (a.sends <= b.sends ? a : b));
  } else if (Math.random() < EXPLORE_RATE) {
    chosen = variants[Math.floor(Math.random() * variants.length)];
  } else {
    // Exploit: best response rate
    chosen = variants.reduce((a, b) =>
      a.responses / a.sends >= b.responses / b.sends ? a : b
    );
  }
  return { experiment, variant: chosen };
}

/** Called when an outbound message is actually sent under a variant. */
export async function recordSend(variantId: string): Promise<void> {
  await prisma.experimentVariant
    .update({ where: { id: variantId }, data: { sends: { increment: 1 } } })
    .catch(() => undefined);
}

/**
 * Called when an inbound reply arrives from a lead on a channel. Finds the most
 * recent variant-tagged outbound message to that lead on that channel that
 * hasn't been credited yet (across all their conversations on the channel),
 * marks it, and increments the variant's response count.
 */
export async function recordResponseForInbound(
  leadId: string,
  channel: 'EMAIL' | 'SMS' | 'VOICE' | 'SOCIAL'
): Promise<void> {
  const message = await prisma.message.findFirst({
    where: {
      direction: 'OUTBOUND',
      experimentVariantId: { not: null },
      gotResponse: false,
      conversation: { leadId, channel },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!message?.experimentVariantId) return;

  await prisma.$transaction([
    prisma.message.update({ where: { id: message.id }, data: { gotResponse: true } }),
    prisma.experimentVariant.update({
      where: { id: message.experimentVariantId },
      data: { responses: { increment: 1 } },
    }),
  ]);
}

export async function getExperimentResults(experimentId: string, organizationId: string) {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, organizationId },
    include: { variants: { orderBy: { createdAt: 'asc' } } },
  });
  if (!experiment) return null;
  const variants = experiment.variants.map(summarizeVariant);
  const best = variants
    .filter((v) => v.sends >= MIN_SAMPLES)
    .sort((a, b) => b.responseRate - a.responseRate)[0];
  return {
    id: experiment.id,
    name: experiment.name,
    channel: experiment.channel,
    goal: experiment.goal,
    status: experiment.status,
    winnerVariantId: experiment.winnerVariantId,
    leadingVariantId: best?.id ?? null,
    variants,
  };
}
