import { prisma } from '../config/database';
import { notify } from './notification.service';
import { utcDay } from './sender.service';

/**
 * Sender circuit breaker.
 *
 * The warm-up ramp slows a mailbox that is going bad; this stops it. Mailboxes
 * are judged on their own rolling bounce and complaint rates and paused when
 * they cross the lines that get senders blocked, and a domain losing several
 * mailboxes at once is pulled entirely — at that point the problem is the
 * domain or the list, not one address.
 *
 * Every threshold here is deliberately stricter than the point at which a
 * mailbox provider would act: the goal is to stop before someone else does.
 */

const DAY_MS = 24 * 3600 * 1000;

/** Rolling window every rate is measured over. */
const HEALTH_WINDOW_DAYS = 7;

/**
 * Hard bounces. Providers start throttling in the low single digits and Google
 * publishes 5% as the point of real trouble, so the breaker sits at 5% with
 * enough volume behind it that one bad address on a small day can't trip it.
 */
const BOUNCE_MIN_SENDS = 20;
const BOUNCE_PAUSE_RATE = 0.05;

/**
 * Spam complaints. Google's stated limit is 0.3% and there is no grace above
 * it, so this is the same number rather than a fraction of it.
 */
const COMPLAINT_MIN_SENDS = 50;
const COMPLAINT_PAUSE_RATE = 0.003;

/** How long a health-paused mailbox sits out before it is offered again. */
const MAILBOX_COOLDOWN_HOURS = 24;

/**
 * Health-paused mailboxes before the domain itself is pulled — at least this
 * many, and at least half of what the domain has. A two-mailbox domain losing
 * both is a domain problem; a ten-mailbox pool losing two is two bad lists, and
 * pulling the other eight over it would cost more than it saves. The aggregate
 * check below is what catches a large pool that is genuinely rotten.
 */
const DOMAIN_TRIP_MAILBOXES = 2;
/** Volume a domain needs before its own aggregate rates mean anything. */
const DOMAIN_MIN_SENDS = 50;

export interface HealthTotals {
  sent: number;
  bounced: number;
  complained: number;
  replied: number;
}

export interface HealthVerdict extends HealthTotals {
  bounceRate: number;
  complaintRate: number;
  replyRate: number;
  /** Why sending must stop, or null when the numbers are acceptable. */
  breach: string | null;
}

const ZERO: HealthTotals = { sent: 0, bounced: 0, complained: 0, replied: 0 };

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * Judge a set of totals. Pure so the thresholds can be reasoned about — and
 * tested — without a database behind them.
 *
 * Minimum volumes matter as much as the rates: two bounces out of three sends
 * is 67% and means nothing, and pausing on it would take a new mailbox out on
 * its first bad morning.
 */
export function assess(totals: HealthTotals): HealthVerdict {
  const { sent, bounced, complained, replied } = totals;
  const bounceRate = sent > 0 ? bounced / sent : 0;
  const complaintRate = sent > 0 ? complained / sent : 0;
  const replyRate = sent > 0 ? replied / sent : 0;

  let breach: string | null = null;
  if (sent >= BOUNCE_MIN_SENDS && bounceRate > BOUNCE_PAUSE_RATE) {
    breach =
      `hard bounce rate ${pct(bounceRate)} over ${HEALTH_WINDOW_DAYS}d ` +
      `(${bounced}/${sent}) — limit ${pct(BOUNCE_PAUSE_RATE)}`;
  } else if (sent >= COMPLAINT_MIN_SENDS && complaintRate > COMPLAINT_PAUSE_RATE) {
    breach =
      `spam complaint rate ${pct(complaintRate)} over ${HEALTH_WINDOW_DAYS}d ` +
      `(${complained}/${sent}) — limit ${pct(COMPLAINT_PAUSE_RATE)}`;
  }
  return { sent, bounced, complained, replied, bounceRate, complaintRate, replyRate, breach };
}

function add(a: HealthTotals, b: HealthTotals): HealthTotals {
  return {
    sent: a.sent + b.sent,
    bounced: a.bounced + b.bounced,
    complained: a.complained + b.complained,
    replied: a.replied + b.replied,
  };
}

/**
 * Rolling totals per mailbox.
 *
 * Each mailbox is only counted from the start of its current warm-up. That is
 * what makes the cooldown work: a resumed mailbox begins with a clean window
 * instead of re-reading the week that got it paused and pausing again on the
 * spot, forever.
 */
export async function healthByMailbox(
  now: Date = new Date(),
  mailboxIds?: string[]
): Promise<Map<string, HealthVerdict>> {
  const windowStart = utcDay(new Date(now.getTime() - (HEALTH_WINDOW_DAYS - 1) * DAY_MS));
  const [rows, mailboxes] = await Promise.all([
    prisma.mailboxDailyStat.findMany({
      where: {
        date: { gte: windowStart },
        ...(mailboxIds ? { mailboxId: { in: mailboxIds } } : {}),
      },
    }),
    prisma.mailbox.findMany({
      where: mailboxIds ? { id: { in: mailboxIds } } : {},
      select: { id: true, warmupStartedAt: true },
    }),
  ]);

  const floorById = new Map(
    mailboxes.map((m) => [
      m.id,
      m.warmupStartedAt ? Math.max(windowStart.getTime(), utcDay(m.warmupStartedAt).getTime()) : windowStart.getTime(),
    ])
  );

  const totals = new Map<string, HealthTotals>();
  for (const row of rows) {
    const floor = floorById.get(row.mailboxId);
    if (floor === undefined || row.date.getTime() < floor) continue;
    totals.set(row.mailboxId, add(totals.get(row.mailboxId) ?? ZERO, row));
  }

  const verdicts = new Map<string, HealthVerdict>();
  for (const m of mailboxes) verdicts.set(m.id, assess(totals.get(m.id) ?? ZERO));
  return verdicts;
}

export interface SweepResult {
  mailboxesPaused: number;
  mailboxesResumed: number;
  domainsPaused: number;
}

/**
 * One pass of the breaker: return cooled-off mailboxes to service, then pause
 * whatever has since gone bad, then pull any domain that is losing several
 * mailboxes at once.
 *
 * Resuming first is deliberate. A mailbox coming back starts a fresh warm-up,
 * so it has no sends in its window and cannot be re-paused by the same numbers
 * that paused it — the evaluation below simply passes over it until it has sent
 * enough for a new verdict.
 */
export async function runSenderHealthSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { mailboxesPaused: 0, mailboxesResumed: 0, domainsPaused: 0 };

  result.mailboxesResumed = await resumeCooledMailboxes(now);

  // Only mailboxes that are actually in service can breach.
  const live = await prisma.mailbox.findMany({
    where: { status: { in: ['WARMING', 'ACTIVE'] } },
    include: { emailDomain: { select: { id: true, domain: true, purpose: true } } },
  });
  if (live.length === 0) return result;

  const verdicts = await healthByMailbox(
    now,
    live.map((m) => m.id)
  );

  for (const mailbox of live) {
    const verdict = verdicts.get(mailbox.id);
    if (!verdict?.breach) continue;

    // Conditional update, so two workers sweeping at once can't both pause the
    // same mailbox and send two alerts about it.
    const claimed = await prisma.mailbox.updateMany({
      where: { id: mailbox.id, status: { in: ['WARMING', 'ACTIVE'] } },
      data: {
        status: 'PAUSED',
        pausedReason: verdict.breach,
        pausedUntil: new Date(now.getTime() + MAILBOX_COOLDOWN_HOURS * 3600 * 1000),
      },
    });
    if (claimed.count === 0) continue;
    result.mailboxesPaused++;

    // The alert rides a transactional sender, so it still goes out even when the
    // cold domain it is warning about is the one that just stopped.
    await notify({
      organizationId: mailbox.organizationId,
      type: 'SYSTEM',
      title: `Sending paused: ${mailbox.address}`,
      body:
        `${mailbox.address} was paused automatically — ${verdict.breach}. ` +
        `It returns to a fresh warm-up in ${MAILBOX_COOLDOWN_HOURS}h. ` +
        'Check the list this mailbox has been working before then: a bounce rate ' +
        'this high is usually the addresses, not the domain.',
      emailAlert: true,
    }).catch(() => undefined);
  }

  result.domainsPaused = await pauseFailingDomains(now);
  return result;
}

/**
 * Return mailboxes whose cooldown has elapsed.
 *
 * `pausedUntil` is what marks a pause as this system's to undo — a human who
 * pauses a mailbox leaves it null, and it stays paused until a human says
 * otherwise. Resuming restarts the warm-up from the beginning rather than
 * dropping back in at full volume: a mailbox that has just bounced its way out
 * of service has not earned the allowance it had.
 */
async function resumeCooledMailboxes(now: Date): Promise<number> {
  const due = await prisma.mailbox.findMany({
    where: { status: 'PAUSED', pausedUntil: { lte: now } },
    select: { id: true, address: true, organizationId: true },
  });

  let resumed = 0;
  for (const mailbox of due) {
    const claimed = await prisma.mailbox.updateMany({
      where: { id: mailbox.id, status: 'PAUSED', pausedUntil: { lte: now } },
      data: {
        status: 'WARMING',
        pausedUntil: null,
        pausedReason: null,
        // Restarts both the ramp and the health window in one move.
        warmupStartedAt: now,
      },
    });
    if (claimed.count === 0) continue;
    resumed++;
    await notify({
      organizationId: mailbox.organizationId,
      type: 'SYSTEM',
      title: `Sending resumed: ${mailbox.address}`,
      body: `${mailbox.address} finished its cooldown and is warming up again from the start.`,
    }).catch(() => undefined);
  }
  return resumed;
}

/**
 * Pull a domain when several of its mailboxes have been paused, or when its own
 * aggregate rates breach.
 *
 * Domains are never resumed automatically. Losing a mailbox is routine and a
 * cooldown handles it; losing a domain means the DNS, the reputation or the
 * list is wrong, and putting it back on the wire unattended would spend what is
 * left of it. A human clears this one.
 */
async function pauseFailingDomains(now: Date): Promise<number> {
  const domains = await prisma.emailDomain.findMany({
    where: { status: { in: ['WARMING', 'ACTIVE'] } },
    include: { mailboxes: { select: { id: true, status: true, pausedUntil: true } } },
  });

  let paused = 0;
  for (const domain of domains) {
    // Decommissioned addresses are not part of the fleet. Counting them would
    // let three retired mailboxes keep a domain alive while both of its working
    // ones sit paused for bouncing.
    const fleet = domain.mailboxes.filter((m) => m.status !== 'RETIRED');
    if (fleet.length === 0) continue;

    // Health pauses carry a cooldown; ones a human set do not, and must not
    // count toward pulling the whole domain.
    const healthPaused = fleet.filter(
      (m) => m.status === 'PAUSED' && m.pausedUntil !== null
    ).length;
    const live = fleet.filter((m) => m.status === 'WARMING' || m.status === 'ACTIVE');

    let reason: string | null = null;
    if (healthPaused >= DOMAIN_TRIP_MAILBOXES && healthPaused * 2 >= fleet.length) {
      reason = `${healthPaused} of ${fleet.length} mailboxes on this domain were paused for deliverability`;
    }
    // Independent of the count rule: a fleet that is still sending badly should
    // trip even when too few mailboxes have individually crossed the line.
    if (!reason && live.length > 0) {
      // Judge only what is still sending. Counting mailboxes already stopped
      // would let one bad address condemn the domain it sits on — their volume
      // has been dealt with, and what matters is whether the rest is holding up.
      const verdicts = await healthByMailbox(
        now,
        live.map((m) => m.id)
      );
      const totals = [...verdicts.values()].reduce<HealthTotals>((acc, v) => add(acc, v), ZERO);
      if (totals.sent >= DOMAIN_MIN_SENDS) {
        const verdict = assess(totals);
        if (verdict.breach) reason = `domain-wide ${verdict.breach}`;
      }
    }
    if (!reason) continue;

    const claimed = await prisma.emailDomain.updateMany({
      where: { id: domain.id, status: { in: ['WARMING', 'ACTIVE'] } },
      data: { status: 'PAUSED', pausedReason: reason },
    });
    if (claimed.count === 0) continue;
    paused++;

    await notify({
      organizationId: domain.organizationId,
      type: 'SYSTEM',
      title: `Domain paused: ${domain.domain}`,
      body:
        `${domain.domain} stopped sending — ${reason}. Nothing on this domain will ` +
        'send until you resume it. Check its DNS and authentication, and review the ' +
        'lists it has been working; this does not clear on its own.',
      emailAlert: true,
    }).catch(() => undefined);
  }
  return paused;
}
