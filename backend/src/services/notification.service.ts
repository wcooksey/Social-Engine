import { NotificationType } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { deliverEmail } from './email-delivery.service';
import { resolveSender } from './sender.service';

/**
 * In-app + email notifications so a human knows when something worth their
 * attention happens on autopilot: a meeting booked, a hot reply, a lead going
 * INTERESTED. Instant alerts fan out to org users who opted into email; a daily
 * digest summarizes the rest.
 */

export interface CreateNotificationInput {
  organizationId: string;
  type: NotificationType;
  title: string;
  body?: string;
  leadId?: string;
  /** Send an immediate alert email to opted-in org users. */
  emailAlert?: boolean;
}

export async function notify(input: CreateNotificationInput): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      title: input.title,
      body: input.body,
      leadId: input.leadId,
    },
  });

  if (input.emailAlert) {
    await sendAlertEmail(input.organizationId, notification.id, input.title, input.body).catch(
      () => undefined // best-effort; the in-app notification is the source of truth
    );
  }
}

async function sendAlertEmail(
  organizationId: string,
  notificationId: string,
  title: string,
  body?: string
): Promise<void> {
  const sender = await resolveSender(organizationId, { purpose: 'TRANSACTIONAL' });
  if (!sender) return;

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const recipients = await prisma.user.findMany({
    where: { organizationId, isActive: true, notifyByEmail: true },
    select: { email: true },
  });
  if (recipients.length === 0) return;

  const text = `${title}\n\n${body || ''}\n\nOpen Social Engine: ${config.appPublicUrl}`.trim();
  await Promise.all(
    recipients.map((r) =>
      deliverEmail(sender, {
        to: r.email,
        subject: `🔔 ${title}`,
        body: text,
        fromName: `${org?.name || 'Social Engine'} Alerts`,
        fromEmail: sender.fromEmail,
      })
    )
  );
  await prisma.notification.update({
    where: { id: notificationId },
    data: { emailedAt: new Date() },
  });
}

export async function listNotifications(organizationId: string, unreadOnly = false) {
  return prisma.notification.findMany({
    where: { organizationId, ...(unreadOnly ? { read: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function unreadCount(organizationId: string): Promise<number> {
  return prisma.notification.count({ where: { organizationId, read: false } });
}

export async function markRead(organizationId: string, ids?: string[]): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { organizationId, read: false, ...(ids && ids.length ? { id: { in: ids } } : {}) },
    data: { read: true },
  });
  return result.count;
}

/**
 * Build and send a daily digest per org: what the autopilot did in the last 24h
 * (meetings booked, replies, leads advanced) to each opted-in user. Called by
 * the worker's daily sweep.
 */
export async function sendDailyDigest(organizationId: string): Promise<boolean> {
  const sender = await resolveSender(organizationId, { purpose: 'TRANSACTIONAL' });
  if (!sender) return false;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [meetings, replies, interested, sent, calls] = await Promise.all([
    prisma.calendarEvent.count({ where: { organizationId, createdAt: { gte: since } } }),
    prisma.activity.count({
      where: { organizationId, type: { in: ['EMAIL_REPLY', 'SMS_REPLY'] }, createdAt: { gte: since } },
    }),
    prisma.lead.count({ where: { organizationId, status: 'INTERESTED', updatedAt: { gte: since } } }),
    prisma.activity.count({
      where: { organizationId, type: { in: ['EMAIL_SENT', 'SMS_SENT'] }, createdAt: { gte: since } },
    }),
    prisma.activity.count({ where: { organizationId, type: 'CALL_PLACED', createdAt: { gte: since } } }),
  ]);

  if (meetings + replies + interested + sent + calls === 0) return false; // nothing to report

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const recipients = await prisma.user.findMany({
    where: { organizationId, isActive: true, notifyByEmail: true },
    select: { email: true, firstName: true },
  });
  if (recipients.length === 0) return false;

  const lines = [
    `Here's what your Social Engine did in the last 24 hours:`,
    ``,
    `• ${meetings} meeting${meetings === 1 ? '' : 's'} booked`,
    `• ${replies} lead repl${replies === 1 ? 'y' : 'ies'} received`,
    `• ${interested} lead${interested === 1 ? '' : 's'} marked interested`,
    `• ${sent} message${sent === 1 ? '' : 's'} sent`,
    `• ${calls} call${calls === 1 ? '' : 's'} placed`,
    ``,
    `Open Social Engine: ${config.appPublicUrl}`,
  ].join('\n');

  await Promise.all(
    recipients.map((r) =>
      deliverEmail(sender, {
        to: r.email,
        subject: `📊 Your Social Engine daily digest`,
        body: `Hi ${r.firstName || 'there'},\n\n${lines}`,
        fromName: `${org?.name || 'Social Engine'}`,
        fromEmail: sender.fromEmail,
      })
    )
  );
  await notify({
    organizationId,
    type: 'DIGEST',
    title: 'Daily digest sent',
    body: `${meetings} meetings, ${replies} replies, ${sent} sends in the last 24h.`,
  });
  return true;
}
