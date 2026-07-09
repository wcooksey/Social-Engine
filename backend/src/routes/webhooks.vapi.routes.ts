import { Router } from 'express';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { asyncHandler } from '../middleware/error.middleware';
import { leadService } from '../services/lead.service';

const router = Router();

/**
 * Vapi end-of-call webhook. Configure the server URL in the Vapi dashboard
 * as {API_URL}/api/webhooks/vapi with the same secret as VAPI_WEBHOOK_SECRET.
 * Writes the transcript/outcome to the lead timeline and schedules an Engine
 * job to process the result (update status, book follow-ups).
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (config.vapi.webhookSecret) {
      const provided = req.headers['x-vapi-secret'];
      if (provided !== config.vapi.webhookSecret) {
        res.status(401).json({ success: false, error: 'Invalid webhook secret' });
        return;
      }
    }

    const message = req.body?.message;
    if (!message || message.type !== 'end-of-call-report') {
      res.json({ success: true, data: { ignored: true } });
      return;
    }

    const metadata = (message.call?.metadata ?? {}) as Record<string, string>;
    const { organizationId, leadId, campaignId } = metadata;
    if (!organizationId || !leadId) {
      res.json({ success: true, data: { ignored: 'missing metadata' } });
      return;
    }
    const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
    if (!lead) {
      res.json({ success: true, data: { ignored: 'unknown lead' } });
      return;
    }

    const summary: string = message.analysis?.summary || message.summary || 'Call ended';
    const transcript: string = message.artifact?.transcript || message.transcript || '';
    const endedReason: string = message.endedReason || 'unknown';
    const durationSeconds: number | undefined = message.durationSeconds;

    await leadService.logActivity({
      organizationId,
      leadId,
      campaignId,
      type: 'CALL_COMPLETED',
      summary: `AI call ended (${endedReason}${durationSeconds ? `, ${Math.round(durationSeconds)}s` : ''}): ${summary.slice(0, 500)}`,
      payload: {
        vapiCallId: message.call?.id,
        endedReason,
        durationSeconds,
        summary,
        transcript: transcript.slice(0, 15000),
      },
    });

    // Let the Engine process the outcome: status changes, bookings, next steps
    await prisma.agentJob.create({
      data: {
        organizationId,
        leadId,
        campaignId: campaignId || null,
        type: 'FOLLOW_UP',
        role: 'COORDINATOR',
        objective: `An AI phone call with this lead just ended. Review the latest CALL_COMPLETED activity on its timeline (summary and transcript), then: update the lead status if warranted, record any commitments as calendar events, and schedule the appropriate next follow-up per the playbooks (delegate outreach to an SDR or another call to a Caller as needed). Call summary: ${summary.slice(0, 800)}`,
        runAt: new Date(),
      },
    });

    res.json({ success: true, data: { processed: true } });
  })
);

export default router;
