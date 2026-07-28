import Anthropic from '@anthropic-ai/sdk';
import { AutopilotMetric, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import * as channels from '../services/channels.service';
import { leadService } from '../services/lead.service';
import { getVoicePlaybookText } from '../services/playbook.service';
import {
  appendToPlaybook,
  PlaybookEditError,
  strReplaceInPlaybook,
} from '../services/playbook-edit.service';
import {
  getExperimentResults,
  pickVariant,
  recordSend,
  summarizeVariant,
} from '../services/experiment.service';
import {
  loadStorageState,
  PlatformKey,
  saveStorageState,
} from '../services/social-account.service';
import { getOrgConfig } from '../services/settings.service';
import { sweepSocialInbox } from './social-inbox.service';
import { sourceBusinesses } from '../services/places.service';
import * as coverage from '../services/coverage.service';
import {
  apolloPeopleSearch,
  crawlSiteForContacts,
  verifyEmail as verifyEmailAddress,
} from '../services/enrichment.service';
import {
  ENRICHMENT_CAPABILITY_VERSION,
  findEnrichmentTargets,
  getEnrichmentStats,
  recomputeLeadEnrichment,
  recordEnrichmentAttempt,
} from '../services/lead-enrichment.service';
import { llmService } from './llm/llm.service';
import { GUIDE_TOPICS, PLATFORM_GUIDE } from './platform-guide';
import { recordBrowserAction, recordBrowserFrame } from './live-view.registry';
import { notify } from '../services/notification.service';
import { signToken } from '../utils/signing';
import { resolveLeadTimezone, localHourIn, isWithinQuietHours } from '../utils/timezone';
import { runBrowserAgent } from './browser/browser-agent.service';
import { AgentRole, defaultRoleForJobType } from './roles';
import { evaluateGoalProgress } from '../services/autopilot.service';
import { buildCallSystemPrompt } from './prompts';
import { researchService } from './research.service';

export interface ToolContext {
  organizationId: string;
  runId: string;
  /**
   * Sandbox mode: run the real prompt, playbooks, role and tools, but let
   * NOTHING escape — no message sent, no call placed, no CRM row written.
   * Side-effecting tools report what they would have done instead.
   */
  simulate?: boolean;
}

type ToolInput = Record<string, any>;
type ToolExecutor = (input: ToolInput, ctx: ToolContext) => Promise<unknown>;

/**
 * The Engine's control surface. Every mutation the AI makes goes through one
 * of these executors: validated, org-scoped, deduplicated, and audit-logged
 * via AgentStep. The AI never touches the database directly.
 */
export const engineTools: Anthropic.Tool[] = [
  {
    name: 'search_web',
    description:
      'Search the internet for businesses, people, or pages. Returns titles, URLs, and descriptions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description:
      'Fetch a web page and return its readable text content. Use to research a business website, find contact/about pages, emails, phone numbers, and social links.',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
    },
  },
  {
    name: 'source_local_businesses',
    description:
      'Enumerate local businesses via the Google Places API and add them as leads (deduplicated automatically). Far more complete than search_web for "find all X in Y" — one query returns up to 60 businesses with name, website, phone, and address. For broad objectives, run many granular queries via coverage cells (e.g. per city × brand) rather than one huge query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'e.g. "Toyota dealership in Tampa, FL"' },
        groupName: { type: 'string', description: 'Lead group to add results to (created if missing)' },
        industry: { type: 'string', description: 'Industry label to stamp on created leads' },
        maxResults: { type: 'number', description: 'Cap results (default 60, the API max per query)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plan_coverage',
    description:
      'Plan a systematic coverage grid for a broad sourcing objective ("all dealerships in Florida"): break it into granular cells (e.g. one per city × brand, or city × category) and register them on a lead group. Idempotent — re-planning skips cells that already exist, so it is safe across sessions. After planning, work cells with claim_coverage_cells.',
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string', description: 'Lead group that owns this objective (created if missing)' },
        cells: {
          type: 'array',
          description: 'The grid: each cell is one small search',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'e.g. "Toyota — Tampa, FL"' },
              query: { type: 'string', description: 'e.g. "Toyota dealership in Tampa, FL"' },
            },
            required: ['query'],
          },
        },
      },
      required: ['groupName', 'cells'],
    },
  },
  {
    name: 'list_coverage',
    description:
      'Check coverage progress for a group: totals (pending/in-progress/done/empty, leads found) plus a sample of remaining cells. Use this to know exactly what has and has not been covered before searching — never repeat covered ground.',
    input_schema: {
      type: 'object' as const,
      properties: { groupName: { type: 'string' } },
      required: ['groupName'],
    },
  },
  {
    name: 'claim_coverage_cells',
    description:
      'Atomically claim the next batch of uncovered cells to work on (safe when multiple agents work in parallel — no two agents get the same cell). For each claimed cell: run source_local_businesses (or search_web/browse_web as fallback) with its query, then call complete_coverage_cell.',
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string' },
        count: { type: 'number', description: 'How many cells to claim (default 3, max 10)' },
      },
      required: ['groupName'],
    },
  },
  {
    name: 'complete_coverage_cell',
    description: 'Mark a claimed coverage cell finished, recording how many leads it produced (0 marks it EMPTY).',
    input_schema: {
      type: 'object' as const,
      properties: {
        cellId: { type: 'string' },
        leadsFound: { type: 'number' },
        notes: { type: 'string', description: 'Anything worth remembering about this cell' },
      },
      required: ['cellId', 'leadsFound'],
    },
  },
  {
    name: 'create_lead_group',
    description: 'Create a named group/segment of leads (e.g. "Florida Dealerships"). Idempotent by name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        goal: { type: 'string', description: 'What we are trying to accomplish with this group' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_leads',
    description:
      'Search existing leads in the CRM. ALWAYS use this to check for duplicates before creating leads, and to build target lists for outreach.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Free text: company name, domain, or city' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        groupName: { type: 'string' },
        state: { type: 'string', description: 'Two-letter state/region filter' },
        limit: { type: 'number', description: 'Max results per page (default 25, max 100)' },
        page: {
          type: 'number',
          description:
            'Page number (1-based). Results include total + hasMore — keep paging until hasMore is false when you need the whole list.',
        },
        maxTier: {
          type: 'string',
          enum: ['NONE', 'MINIMAL', 'PARTIAL', 'GOOD', 'RICH'],
          description:
            'Enrichment filter: return only leads at or BELOW this quality tier (e.g. PARTIAL = everything that still needs research).',
        },
        minTier: {
          type: 'string',
          enum: ['NONE', 'MINIMAL', 'PARTIAL', 'GOOD', 'RICH'],
          description:
            'Enrichment filter: return only leads at or ABOVE this tier. Use minTier=GOOD to build an outreach list of leads that are actually reachable.',
        },
        hasEmail: {
          type: 'boolean',
          description: 'true = only leads with at least one usable email; false = only leads with none.',
        },
        hasPhone: { type: 'boolean', description: 'Filter on having any usable phone number.' },
      },
    },
  },
  {
    name: 'get_enrichment_stats',
    description:
      "Categorize a lead list by how well enriched it is: how many leads are RICH/GOOD/PARTIAL/MINIMAL/NONE, how many have emails (and how many have none), phone coverage, the most common missing signals, and how many are worth re-running enrichment on. Use this BEFORE planning enrichment or outreach on a group so you work from facts, not guesses.",
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string', description: 'Limit to one lead group. Omit for the whole org.' },
      },
    },
  },
  {
    name: 'list_enrichment_targets',
    description:
      "The enrichment work list: leads that are weak AND still worth another pass, weakest first, each with exactly what it's missing. Leads already enriched well (GOOD/RICH), already worked with the current toolset, opted out, or attempted in the last cooldown window are excluded — so you never burn time or API credits re-researching leads that are already done or already exhausted. ALWAYS use this to pick enrichment work instead of search_leads.",
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string' },
        maxTier: {
          type: 'string',
          enum: ['NONE', 'MINIMAL', 'PARTIAL', 'GOOD'],
          description: 'Work leads at or below this tier. Default PARTIAL.',
        },
        limit: { type: 'number', description: 'How many leads to take on (default 25, max 200).' },
        cooldownHours: {
          type: 'number',
          description: 'Skip leads attempted within this many hours (default 24). 0 disables.',
        },
        includeAlreadyAttempted: {
          type: 'boolean',
          description:
            'Default false. Set true ONLY when told to re-sweep everything — it returns leads already worked with the current capability set, which usually finds nothing new.',
        },
      },
    },
  },
  {
    name: 'record_enrichment_attempt',
    description:
      "Record that you finished an enrichment pass on a lead — call this after trying the enrichment tools on it, whether or not you found anything. This stamps the lead with the capability generation you used so future runs skip it until the platform gains new abilities. Skipping this call means the same dead-end lead gets re-worked forever.",
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        outcome: {
          type: 'string',
          enum: ['improved', 'no_new_data', 'blocked'],
          description:
            "'improved' = you saved new contact detail; 'no_new_data' = tried everything, found nothing; 'blocked' = couldn't work it (site down, no domain, missing API key).",
        },
        notes: { type: 'string', description: 'Short note for the lead timeline (what you tried).' },
      },
      required: ['leadId', 'outcome'],
    },
  },
  {
    name: 'upsert_lead',
    description:
      'Create or update a lead (a business/prospect). Deduplicates automatically by website domain, company name + location, and phone. Returns the lead and whether it was created or merged.',
    input_schema: {
      type: 'object' as const,
      properties: {
        companyName: { type: 'string' },
        website: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
        industry: { type: 'string' },
        groupName: { type: 'string', description: 'Group to place the lead in (created if missing)' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        aiSummary: { type: 'string', description: 'Your research notes about this lead' },
        socials: {
          type: 'object',
          description: 'Social profile URLs, e.g. {"linkedin": "...", "facebook": "..."}',
        },
      },
      required: ['companyName'],
    },
  },
  {
    name: 'upsert_contact',
    description:
      'Add or update a person at a lead (decision maker, manager). Deduplicates by email within the lead. Only record contact details you actually found.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        title: { type: 'string', description: 'Job title, e.g. "General Manager"' },
        email: { type: 'string' },
        phone: { type: 'string' },
        socials: { type: 'object' },
        isPrimary: { type: 'boolean' },
      },
      required: ['leadId', 'firstName'],
    },
  },
  {
    name: 'find_contacts_on_website',
    description:
      "Crawl a lead's own website (homepage + contact/about/team pages) and extract published emails and phone numbers. Emails found here are usually live since the business publishes them — prefer this before Apollo. Returns findings for you to save via upsert_contact (match names/titles from page context when possible).",
    input_schema: {
      type: 'object' as const,
      properties: { leadId: { type: 'string' } },
      required: ['leadId'],
    },
  },
  {
    name: 'enrich_contacts_apollo',
    description:
      "Find decision makers at a lead's company via the Apollo.io database (searches by the lead's website domain + job titles). People with unlocked emails are saved as contacts automatically. Apollo emails can be stale — verify_email important ones before cold emailing. Requires the Apollo API key in Settings.",
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job titles to target, e.g. ["Owner", "General Manager", "Sales Manager"]',
        },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'verify_email',
    description:
      'Check whether an email address is deliverable BEFORE cold-emailing it (protects sender reputation — bounces hurt future deliverability). Undeliverable addresses are suppressed automatically on the matching contact. Uses Mailgun email validation.',
    input_schema: {
      type: 'object' as const,
      properties: { email: { type: 'string' } },
      required: ['email'],
    },
  },
  {
    name: 'get_lead_timeline',
    description:
      'Get a lead with its contacts and recent activity timeline. ALWAYS read this before messaging a lead so outreach reflects history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        limit: { type: 'number', description: 'Max activities (default 20)' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a research note or observation to a lead timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['leadId', 'note'],
    },
  },
  {
    name: 'update_lead_status',
    description: 'Move a lead through the pipeline (e.g. to INTERESTED after a positive reply).',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        reason: { type: 'string' },
      },
      required: ['leadId', 'status'],
    },
  },
  {
    name: 'create_campaign',
    description: 'Create an outreach campaign with an offer and channel mix.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        offer: { type: 'string', description: 'The pitch/offer to work from' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['EMAIL', 'SMS', 'VOICE', 'SOCIAL'] },
        },
        mode: {
          type: 'string',
          enum: ['AUTONOMOUS', 'APPROVAL_REQUIRED'],
          description: 'AUTONOMOUS sends without human approval; default APPROVAL_REQUIRED',
        },
        followUpCadenceDays: { type: 'number' },
        maxTouches: { type: 'number' },
        autoEnrollGroupName: {
          type: 'string',
          description:
            'Lead group to link for auto-enrollment: every lead that lands in this group (now or later) is enrolled into the campaign automatically by the cadence sweep. The best way to make sourcing flow straight into outreach.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_leads_to_campaign',
    description: 'Enroll leads into a campaign (skips leads already enrolled).',
    input_schema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string' },
        leadIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['campaignId', 'leadIds'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send (or draft, in approval mode / when the channel is unconfigured) an email to a lead contact. Records the message on the lead conversation and timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string', description: 'Target contact; defaults to primary contact' },
        subject: { type: 'string' },
        body: { type: 'string' },
        campaignId: { type: 'string' },
        experimentVariantId: { type: 'string', description: 'If this send is part of a split test, the variant id from pick_experiment_variant' },
      },
      required: ['leadId', 'subject', 'body'],
    },
  },
  {
    name: 'send_sms',
    description:
      'Send (or draft) an SMS to a lead contact. Records the message on the lead conversation and timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string' },
        body: { type: 'string' },
        campaignId: { type: 'string' },
        experimentVariantId: { type: 'string', description: 'If this send is part of a split test, the variant id from pick_experiment_variant' },
      },
      required: ['leadId', 'body'],
    },
  },
  {
    name: 'place_call',
    description:
      'Place a live AI voice call to a lead contact. The voice assistant gets the lead context, your objective, and the team VOICE playbooks as its call script; the transcript lands on the lead timeline when the call ends. Uses the contact phone or the lead company phone. If the call hits voicemail, the assistant leaves voicemailMessage (or a sensible default) instead of hanging up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        contactId: { type: 'string' },
        objective: { type: 'string', description: 'What the call should accomplish' },
        campaignId: { type: 'string' },
        voicemailMessage: {
          type: 'string',
          description: 'What to say if voicemail answers (~15-25s: who you are, why you called, callback number or that you will follow up by text/email)',
        },
      },
      required: ['leadId', 'objective'],
    },
  },
  {
    name: 'browse_web',
    description:
      'Drive a real web browser to research on the open internet or social platforms (LinkedIn, Facebook, Instagram, X). Use for tasks search_web/fetch_page can\'t do: navigating multi-step sites, finding a decision maker\'s social profile, reading a company page, gathering contact details. Research only — it cannot send messages. Give a specific objective and optionally a starting URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        objective: {
          type: 'string',
          description: 'What to find or accomplish, e.g. "Find the LinkedIn profile and title of the General Manager of Sunshine Toyota in Tampa FL"',
        },
        startUrl: { type: 'string', description: 'Optional starting URL' },
        platform: {
          type: 'string',
          enum: ['linkedin', 'facebook', 'instagram', 'x'],
          description: 'If researching on a social platform, set this to use the connected logged-in session',
        },
        leadId: { type: 'string', description: 'Lead to attach findings to (logs a research activity)' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'find_business_page',
    description:
      "Find and verify a lead's OFFICIAL business page on a social platform (the dealership's own Facebook page / Instagram account, not an employee's personal profile). Nearly every established business has one, and its inbox is the highest-yield first touch — no identity guesswork, and messaging a business page is what those inboxes exist for. Verifies the match against the company name, city/state, and the website/phone on file before saving it to the lead's socials. Run this BEFORE hunting for individual people on social.",
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        platform: {
          type: 'string',
          enum: ['facebook', 'instagram', 'linkedin', 'x'],
        },
      },
      required: ['leadId', 'platform'],
    },
  },
  {
    name: 'send_social_dm',
    description:
      'Use the browser to find a lead contact on a social platform and send them a direct message / connection request. COLD DM RULE: each lead gets exactly ONE cold DM per platform — the tool refuses repeats unless allowRepeat is set (replies are handled by the inbound loop, not by re-DMing). Requires the org to have social autonomy enabled; otherwise the message is recorded as a draft for human approval. Records a social touch on the lead timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: { type: 'string' },
        platform: {
          type: 'string',
          enum: ['linkedin', 'facebook', 'instagram', 'x'],
        },
        profileUrl: { type: 'string', description: 'Direct profile URL if known (skips searching)' },
        personName: { type: 'string', description: 'Who to reach if no profileUrl' },
        message: { type: 'string', description: 'The DM text to send' },
        target: {
          type: 'string',
          enum: ['business_page', 'person'],
          description:
            "Who to message. 'business_page' = the company's own page inbox (DEFAULT when the lead has a page on file, and the preferred first touch — no identity guesswork). 'person' = a named individual, for when the page has no DM option or didn't respond. Each target gets its own one-cold-DM allowance, so a page DM does not use up the person DM.",
        },
        allowRepeat: {
          type: 'boolean',
          description: 'Override the one-cold-DM rule for this target (only when the lead has replied and you must respond via browser)',
        },
      },
      required: ['leadId', 'platform', 'message'],
    },
  },
  {
    name: 'check_social_inbox',
    description:
      "Read a connected social account's DM inbox for NEW replies from prospects (read-only — sends nothing). Matched replies are ingested automatically: they land on the lead conversation/timeline, pause the campaign cadence, alert the humans, and queue an SDR to respond. The platform also runs this hourly on its own; call it when the user asks to check DMs now or when you just sent DMs and expect replies.",
    input_schema: {
      type: 'object' as const,
      properties: {
        platform: {
          type: 'string',
          enum: ['linkedin', 'facebook', 'instagram', 'x'],
        },
      },
      required: ['platform'],
    },
  },
  {
    name: 'schedule_followup',
    description:
      'Schedule future work — for your future self OR to hand off to a specialist agent. Set role to delegate: RESEARCHER (find/enrich leads), CALLER (place a call), SDR (email/SMS/social outreach), or COORDINATOR (general). The assigned agent wakes at runAt with the full shared context and executes the objective. This is how the team divides labor and stays persistent across days/weeks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        objective: { type: 'string', description: 'Instruction for the agent that runs this, with all needed context' },
        type: { type: 'string', enum: ['FOLLOW_UP', 'RESEARCH', 'CAMPAIGN_STEP', 'CUSTOM'] },
        role: {
          type: 'string',
          enum: ['RESEARCHER', 'CALLER', 'SDR', 'COORDINATOR'],
          description: 'Which specialist should run this job. Defaults from type if omitted.',
        },
        leadId: { type: 'string' },
        campaignId: { type: 'string' },
        delayHours: { type: 'number', description: 'Hours from now (alternative to runAtIso)' },
        runAtIso: { type: 'string', description: 'Absolute ISO-8601 time' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'list_calendar_events',
    description:
      'Read the calendar: list events in a date range (meetings, calls, demos booked with leads). ALWAYS check the calendar before booking anything to avoid double-booking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startIso: { type: 'string', description: 'Range start (ISO-8601). Defaults to now.' },
        endIso: { type: 'string', description: 'Range end (ISO-8601). Defaults to 14 days from start.' },
        leadId: { type: 'string', description: 'Only events for this lead' },
      },
    },
  },
  {
    name: 'get_booking_links',
    description:
      "List this organization's active public booking links (self-serve scheduling pages). Include a link URL in outreach so interested leads can book a meeting themselves — often more effective than negotiating a time back and forth.",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_calendar_event',
    description:
      'Book an event on the calendar: a meeting, demo, or call with a lead. Use after a lead agrees to a time. Also logs the booking on the lead timeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        startAtIso: { type: 'string', description: 'Start time (ISO-8601)' },
        endAtIso: { type: 'string', description: 'End time (ISO-8601)' },
        allDay: { type: 'boolean' },
        type: { type: 'string', enum: ['MEETING', 'CALL', 'DEMO', 'FOLLOW_UP', 'OTHER'] },
        description: { type: 'string' },
        location: { type: 'string', description: 'Address, phone number, or meeting link' },
        leadId: { type: 'string' },
        contactId: { type: 'string' },
      },
      required: ['title', 'startAtIso'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Reschedule, complete, or cancel a calendar event (e.g. when a lead asks to move a demo).',
    input_schema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string' },
        title: { type: 'string' },
        startAtIso: { type: 'string' },
        endAtIso: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['SCHEDULED', 'COMPLETED', 'CANCELLED'] },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'list_playbooks',
    description:
      'List the org\'s playbooks (your editable instructions/protocols) with their full current text, so you can edit them precisely. Use before editing to copy exact snippets.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'edit_playbook_text',
    description:
      'Surgically edit a playbook: replace an exact snippet with new text, leaving the rest untouched — like editing specific lines of code, no full rewrite. The find text must match exactly once. Use this to tweak calling instructions, outreach rules, etc. when the user asks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        playbookId: { type: 'string' },
        find: { type: 'string', description: 'Exact text to replace (copy verbatim from list_playbooks; include enough context to be unique)' },
        replace: { type: 'string', description: 'New text to put in its place' },
      },
      required: ['playbookId', 'find', 'replace'],
    },
  },
  {
    name: 'append_playbook',
    description: 'Add a new line/paragraph to the end of a playbook without touching existing text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        playbookId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['playbookId', 'text'],
    },
  },
  {
    name: 'create_playbook',
    description:
      'Create a new playbook (protocol) the team/you will follow. Scope it to everything, a group, a campaign, or a lead status, and optionally a channel (VOICE = call script).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        instructions: { type: 'string' },
        scope: { type: 'string', enum: ['GLOBAL', 'GROUP', 'CAMPAIGN', 'LEAD_STATUS'] },
        groupName: { type: 'string' },
        campaignId: { type: 'string' },
        leadStatus: {
          type: 'string',
          enum: ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'],
        },
        channel: { type: 'string', enum: ['ALL', 'EMAIL', 'SMS', 'VOICE'] },
      },
      required: ['name', 'instructions'],
    },
  },
  {
    name: 'set_playbook_active',
    description: 'Turn a playbook on or off.',
    input_schema: {
      type: 'object' as const,
      properties: { playbookId: { type: 'string' }, isActive: { type: 'boolean' } },
      required: ['playbookId', 'isActive'],
    },
  },
  {
    name: 'create_experiment',
    description:
      'Start a split test (A/B/n) of outreach message variants on a channel, so you can learn which performs best. Each variant is a message/approach; the platform tracks sends and replies per variant.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        channel: {
          type: 'string',
          enum: ['EMAIL', 'SMS'],
          description: 'Only EMAIL and SMS support automatic send/response attribution',
        },
        goal: { type: 'string', description: 'What a "response" means / what you\'re optimizing for' },
        variants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              content: { type: 'string', description: 'The message template or approach for this variant' },
              weight: { type: 'number' },
            },
            required: ['label', 'content'],
          },
        },
        campaignId: { type: 'string' },
      },
      required: ['name', 'channel', 'variants'],
    },
  },
  {
    name: 'list_experiments',
    description: 'List experiments with per-variant results (sends, responses, response rate) so you can see what is working.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'pick_experiment_variant',
    description:
      'Before sending an experiment message to a lead, call this to get which variant to use next (it balances exploring new variants and exploiting the best one). Then send the message using that variant\'s content, passing experimentVariantId to the send tool so the result is tracked.',
    input_schema: {
      type: 'object' as const,
      properties: { experimentId: { type: 'string' } },
      required: ['experimentId'],
    },
  },
  {
    name: 'conclude_experiment',
    description: 'Mark an experiment complete, optionally recording the winning variant. Use once results are clear.',
    input_schema: {
      type: 'object' as const,
      properties: {
        experimentId: { type: 'string' },
        winnerVariantId: { type: 'string' },
      },
      required: ['experimentId'],
    },
  },
  {
    name: 'explain_platform',
    description:
      "Consult the platform operator's manual to accurately explain how Social Engine works or walk the user through setup — settings, channel/webhook wiring, outreach & cadence mechanics, sourcing & enrichment, booking, monitoring, safety rails. Use whenever the user asks how something works, how to set something up, or what the platform can do; answer from it faithfully rather than guessing.",
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          enum: ['overview', 'settings', 'channels_setup', 'outreach_flow', 'sourcing_enrichment', 'booking_meetings', 'monitoring', 'safety'],
          description: 'Omit to get the full guide',
        },
      },
    },
  },
  {
    name: 'get_setup_status',
    description:
      "Check what's configured and what's missing across the whole workspace: channels (email/SMS/voice/social), sourcing & enrichment keys, playbooks, campaigns, booking links, guardrails. Use when the user asks to 'set everything up', to diagnose why something isn't sending, or to walk them through onboarding — then fix what you can with your tools and tell them exactly which API keys to add in Settings (never ask for key values in chat).",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_booking_link',
    description:
      'Create a public self-serve booking link (leads pick a time; it lands on the calendar with an emailed invite). Defaults to Mon–Fri 09:00–17:00 in the given timezone. Returns the public URL to drop into outreach.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'e.g. "15-min intro call"' },
        description: { type: 'string' },
        durationMinutes: { type: 'number', description: 'Default 30' },
        timezone: { type: 'string', description: 'IANA tz the availability is defined in, e.g. "America/New_York"' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_org_guardrails',
    description:
      'Adjust outreach guardrails when the user asks: daily send cap and quiet hours (24h local hours; quiet window applies in each LEAD\'s timezone). The kill switch and social autonomy stay human-only in Settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dailySendCap: { type: 'number', description: '1–2000' },
        quietHoursStart: { type: 'number', description: '0–23, start of no-contact window' },
        quietHoursEnd: { type: 'number', description: '0–23, end of no-contact window' },
      },
    },
  },
  {
    name: 'update_group_summary',
    description:
      'Update the rolling AI summary on a lead group — your long-term memory of progress, findings, and next steps for that group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        groupName: { type: 'string' },
        aiSummary: { type: 'string' },
      },
      required: ['groupName', 'aiSummary'],
    },
  },
  {
    name: 'create_autopilot_goal',
    description:
      'Create a STANDING goal the platform works mechanically: a sweep re-queues an agent job with this objective every cadenceHours until the goal completes — autonomy that survives failed jobs and forgotten follow-ups. Use for open-ended mandates like "keep sourcing dealerships until the group has 500" or "review campaign performance and tune playbooks weekly". Link a leadGroup + targetLeadCount to auto-complete when the target is reached, and set targetMetric to match the work: LEAD_COUNT for sourcing, ENRICHED_LEADS or LEADS_WITH_EMAIL for enrichment. Using LEAD_COUNT on an enrichment goal is a mistake — sourcing already satisfied that number, so the goal completes immediately having done nothing (creation refuses it). Prefer this over chains of schedule_followup for anything meant to run for days or weeks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short label, e.g. "Top up Florida Dealerships"' },
        objective: {
          type: 'string',
          description:
            'The full instruction each queued job executes, with all needed context (the agent gets live progress appended automatically)',
        },
        role: {
          type: 'string',
          enum: ['RESEARCHER', 'CALLER', 'SDR', 'COORDINATOR'],
          description: 'Specialist that runs each cycle (default COORDINATOR)',
        },
        cadenceHours: { type: 'number', description: 'Hours between cycles (default 24)' },
        groupName: { type: 'string', description: 'Lead group this goal works on (optional)' },
        campaignName: { type: 'string', description: 'Campaign this goal relates to (optional)' },
        targetLeadCount: {
          type: 'number',
          description:
            'Auto-complete when the linked group reaches this many of whatever targetMetric counts (optional). Omit to run until paused.',
        },
        targetMetric: {
          type: 'string',
          enum: ['LEAD_COUNT', 'ENRICHED_LEADS', 'LEADS_WITH_EMAIL'],
          description:
            'What targetLeadCount counts. LEAD_COUNT = leads in the group (SOURCING goals only). ENRICHED_LEADS = leads enriched to GOOD/RICH, i.e. reachable for outreach. LEADS_WITH_EMAIL = leads with at least one usable email. Default LEAD_COUNT — you MUST override it for enrichment goals, or the target is already met before the goal starts.',
        },
      },
      required: ['name', 'objective'],
    },
  },
  {
    name: 'list_autopilot_goals',
    description: 'List the standing Autopilot goals: status, cadence, next run, last result.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] },
      },
    },
  },
  {
    name: 'update_autopilot_goal',
    description:
      'Change a standing goal: pause/resume/cancel/complete it, or adjust its objective, cadence, or target.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goalId: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'] },
        objective: { type: 'string' },
        cadenceHours: { type: 'number' },
        targetLeadCount: { type: 'number' },
        targetMetric: {
          type: 'string',
          enum: ['LEAD_COUNT', 'ENRICHED_LEADS', 'LEADS_WITH_EMAIL'],
          description: 'What targetLeadCount counts — switch an enrichment goal off LEAD_COUNT with this.',
        },
      },
      required: ['goalId'],
    },
  },
];

async function requireLead(leadId: string, organizationId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
  if (!lead) throw new Error(`Lead ${leadId} not found in this organization`);
  return lead;
}

/**
 * Hard compliance stop for opted-out leads (SMS STOP / unsubscribe). Enforced
 * in code, not by the model — send tools throw before any draft or send.
 */
function assertContactable(lead: { doNotContact: boolean; companyName: string }): void {
  if (lead.doNotContact) {
    throw new Error(
      `${lead.companyName} has opted out of being contacted (do-not-contact). Do not message this lead on any channel; move on to other work.`
    );
  }
}

/**
 * Outbound guardrails: org kill switch, quiet hours, daily send cap.
 * Returns a reason string when sending is blocked, else null.
 */
async function outboundBlockReason(
  organizationId: string,
  lead?: { timezone?: string | null; state?: string | null }
): Promise<string | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) return 'Organization not found';
  if (org.paused) return 'Organization is paused (kill switch) — no outbound allowed. Save drafts instead.';

  // Quiet hours are evaluated in the LEAD's local timezone when known, so we
  // never text/email someone in the middle of their night.
  const { quietHoursStart: start, quietHoursEnd: end } = org;
  const tz = lead ? resolveLeadTimezone(lead) : undefined;
  const hour = tz ? localHourIn(tz) : new Date().getHours();
  if (isWithinQuietHours(start, end, hour)) {
    return `Inside the lead's quiet hours (${start}:00–${end}:00${tz ? ` ${tz}` : ''}) — schedule the send for later instead.`;
  }

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const sentToday = await prisma.activity.count({
    where: {
      organizationId,
      type: { in: ['EMAIL_SENT', 'SMS_SENT', 'CALL_PLACED'] },
      createdAt: { gte: since },
    },
  });
  if (sentToday >= org.dailySendCap) return `Daily send cap reached (${org.dailySendCap}). Schedule remaining sends for tomorrow.`;
  return null;
}

/**
 * Send-vs-draft policy: draft when guardrails block, when the campaign
 * requires human approval, or when the channel isn't configured. Returns a
 * reason string when only a draft is allowed, else null (real send OK).
 */
async function draftOnlyReason(
  campaignId: string | undefined,
  organizationId: string,
  blocked: string | null,
  configured: boolean,
  kind: 'email' | 'sms' = 'email'
): Promise<string | null> {
  if (blocked) return blocked;
  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      select: { mode: true },
    });
    if (campaign?.mode === 'APPROVAL_REQUIRED') {
      return 'Campaign is in approval-required mode — message saved as a draft for human review.';
    }
  }
  if (!configured) {
    return `${kind === 'email' ? 'Email channel (Mailgun)' : 'SMS channel (Twilio)'} is not configured — message saved as a draft.`;
  }
  return null;
}

/** Attribute a browser sub-agent's LLM usage to the parent run's totals. */
async function attributeBrowserUsage(
  runId: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
): Promise<void> {
  if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) return;
  await prisma.agentRun
    .update({
      where: { id: runId },
      data: {
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        costUsd: { increment: usage.costUsd },
      },
    })
    .catch(() => undefined);
}

/**
 * A real touch happened on a campaign lead: advance its cadence clock so the
 * mechanical sweep knows when the next touch is due. Keeps working even if
 * the agent forgets — persistence is enforced by the system, not remembered.
 */
async function recordCampaignTouch(campaignId: string, leadId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  const nextTouchAt = new Date(Date.now() + campaign.followUpCadenceDays * 24 * 3600 * 1000);
  await prisma.campaignLead.updateMany({
    where: { campaignId, leadId },
    data: { touchCount: { increment: 1 }, lastTouchAt: new Date(), nextTouchAt },
  });
  await prisma.campaignLead.updateMany({
    where: { campaignId, leadId, status: 'PENDING' },
    data: { status: 'IN_SEQUENCE' },
  });
}

async function recordOutbound(opts: {
  ctx: ToolContext;
  leadId: string;
  contactId?: string;
  channel: 'EMAIL' | 'SMS';
  subject?: string;
  body: string;
  campaignId?: string;
  status: string;
  activityType: 'EMAIL_SENT' | 'SMS_SENT';
  activitySummary: string;
  experimentVariantId?: string;
  /** Provider message id (Mailgun/Twilio) — lets delivery/open/click events find this message. */
  externalId?: string;
}) {
  const conversation =
    (await prisma.conversation.findFirst({
      where: { leadId: opts.leadId, channel: opts.channel, contactId: opts.contactId ?? undefined },
    })) ??
    (await prisma.conversation.create({
      data: {
        organizationId: opts.ctx.organizationId,
        leadId: opts.leadId,
        contactId: opts.contactId,
        channel: opts.channel,
        subject: opts.subject,
      },
    }));

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      body: opts.body,
      status: opts.status,
      sentAt: opts.status === 'sent' ? new Date() : null,
      // Mailgun wraps message ids in angle brackets; events echo them bare.
      externalId: opts.externalId?.replace(/^<|>$/g, ''),
      // Only attribute the split-test variant if the message actually went out.
      experimentVariantId: opts.status === 'sent' ? opts.experimentVariantId : undefined,
    },
  });
  if (opts.status === 'sent' && opts.experimentVariantId) {
    await recordSend(opts.experimentVariantId);
  }
  if (opts.status === 'sent' && opts.campaignId) {
    await recordCampaignTouch(opts.campaignId, opts.leadId);
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });
  await leadService.logActivity({
    organizationId: opts.ctx.organizationId,
    leadId: opts.leadId,
    type: opts.activityType,
    summary: opts.activitySummary,
    payload: { subject: opts.subject, body: opts.body, status: opts.status, messageId: message.id },
    campaignId: opts.campaignId,
    agentRunId: opts.ctx.runId,
  });
  return { conversationId: conversation.id, messageId: message.id, status: opts.status };
}

const executors: Record<string, ToolExecutor> = {
  search_web: async (input, ctx) => {
    const orgConfig = await getOrgConfig(ctx.organizationId);
    return researchService.searchWeb(input.query, input.count, orgConfig.search);
  },

  fetch_page: (input) => researchService.fetchPage(input.url),

  create_lead_group: async (input, ctx) => {
    const group = await prisma.leadGroup.upsert({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: input.name.trim() } },
      create: { organizationId: ctx.organizationId, name: input.name.trim(), goal: input.goal },
      update: { ...(input.goal ? { goal: input.goal } : {}) },
    });
    return { id: group.id, name: group.name, goal: group.goal };
  },

  source_local_businesses: async (input, ctx) => {
    const orgConfig = await getOrgConfig(ctx.organizationId);
    const apiKey = orgConfig.search.googlePlacesApiKey;
    if (!apiKey) {
      return {
        found: 0,
        note: 'Google Places API key not configured (Settings → Integrations → Google Places API key). Fall back to search_web/browse_web for this cell, or ask the user to add the key for far more complete sourcing.',
      };
    }
    let groupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.upsert({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
        create: { organizationId: ctx.organizationId, name: String(input.groupName).trim() },
        update: {},
      });
      groupId = group.id;
    }
    const outcome = await sourceBusinesses(ctx.organizationId, input.query, apiKey, {
      groupId,
      industry: input.industry,
      maxResults: Math.min(Number(input.maxResults) || 60, 60),
    });
    return outcome;
  },

  plan_coverage: async (input, ctx) => {
    const group = await prisma.leadGroup.upsert({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
      create: { organizationId: ctx.organizationId, name: String(input.groupName).trim() },
      update: {},
    });
    const cells = (Array.isArray(input.cells) ? input.cells : []) as { label?: string; query: string }[];
    if (cells.length === 0) return { created: 0, existing: 0, note: 'No cells provided' };
    if (cells.length > 500) return { created: 0, existing: 0, note: 'Too many cells in one call (max 500) — plan in batches.' };
    const result = await coverage.planCells(
      ctx.organizationId,
      group.id,
      cells.map((c) => ({ label: c.label || c.query, query: c.query }))
    );
    const summary = await coverage.summarize(group.id);
    return { ...result, coverage: summary };
  },

  list_coverage: async (input, ctx) => {
    const group = await prisma.leadGroup.findUnique({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
    });
    if (!group) return { note: `No group named "${input.groupName}"` };
    const summary = await coverage.summarize(group.id);
    const remaining = await prisma.coverageCell.findMany({
      where: { groupId: group.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'asc' },
      take: 15,
      select: { id: true, label: true, status: true },
    });
    return { coverage: summary, remainingSample: remaining };
  },

  claim_coverage_cells: async (input, ctx) => {
    const group = await prisma.leadGroup.findUnique({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
    });
    if (!group) return { claimed: [], note: `No group named "${input.groupName}"` };
    const count = Math.min(Math.max(Number(input.count) || 3, 1), 10);
    const claimed = await coverage.claimNextCells(ctx.organizationId, group.id, count);
    const summary = await coverage.summarize(group.id);
    return {
      claimed,
      coverage: summary,
      note:
        claimed.length === 0
          ? summary.pending + summary.inProgress === 0
            ? 'Coverage complete — every cell is done. Move to the next phase (enrichment/outreach).'
            : 'No cells claimable right now (others may be in progress).'
          : `Work each cell with source_local_businesses (query as given), then complete_coverage_cell with the lead count.`,
    };
  },

  complete_coverage_cell: async (input, ctx) => {
    await coverage.completeCell(ctx.organizationId, input.cellId, {
      leadsFound: Math.max(0, Number(input.leadsFound) || 0),
      notes: input.notes,
    });
    return { ok: true };
  },

  search_leads: async (input, ctx) => {
    let groupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: input.groupName } },
      });
      if (!group) return { leads: [], total: 0, note: `No group named "${input.groupName}"` };
      groupId = group.id;
    }
    const page = Math.max(1, Number(input.page) || 1);
    const pageSize = Math.min(input.limit || 25, 100);
    const result = await leadService.searchLeads(ctx.organizationId, {
      search: input.search,
      status: input.status,
      groupId,
      state: input.state,
      maxTier: input.maxTier,
      minTier: input.minTier,
      hasEmail: typeof input.hasEmail === 'boolean' ? input.hasEmail : undefined,
      hasPhone: typeof input.hasPhone === 'boolean' ? input.hasPhone : undefined,
      page,
      pageSize,
    });
    return {
      total: result.total,
      page,
      hasMore: page * pageSize < result.total,
      leads: result.leads.map((l) => ({
        id: l.id,
        companyName: l.companyName,
        domain: l.domain,
        city: l.city,
        state: l.state,
        status: l.status,
        group: l.group?.name,
        contactCount: l.contactCount,
        // Enrichment quality travels with every result so you can tell at a
        // glance which leads are reachable and which still need research.
        enrichmentTier: l.enrichmentTier,
        enrichmentScore: l.enrichmentScore,
        emailCount: l.emailCount,
        phoneCount: l.phoneCount,
      })),
    };
  },

  get_enrichment_stats: async (input, ctx) => {
    let groupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
      });
      if (!group) return { note: `No group named "${input.groupName}"` };
      groupId = group.id;
    }
    const stats = await getEnrichmentStats(ctx.organizationId, { groupId });
    return {
      ...stats,
      tierMeaning: {
        RICH: 'decision maker + verified email + phone — nothing left to find',
        GOOD: 'a named contact with a direct email or phone — ready for outreach',
        PARTIAL: 'some detail, but a channel or the decision maker is missing',
        MINIMAL: 'company-level only (main line / generic inbox), no named person',
        NONE: 'no email, no phone, no social — unreachable until enriched',
      },
      note:
        stats.retryability.staleCapability + stats.retryability.neverAttempted > 0
          ? `${stats.retryability.neverAttempted + stats.retryability.staleCapability} lead(s) are worth an enrichment pass — get the work list with list_enrichment_targets. ${stats.retryability.wellEnriched} are already GOOD/RICH: do not re-research those.`
          : `Nothing pending: every weak lead here was already worked with the current toolset (capability v${stats.retryability.currentCapabilityVersion}). Move to outreach, or re-sweep only if the platform gained a new enrichment capability.`,
    };
  },

  list_enrichment_targets: async (input, ctx) => {
    let groupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: String(input.groupName).trim() } },
      });
      if (!group) return { targets: [], note: `No group named "${input.groupName}"` };
      groupId = group.id;
    }
    const result = await findEnrichmentTargets(ctx.organizationId, {
      groupId,
      maxTier: input.maxTier,
      limit: Number(input.limit) || undefined,
      cooldownHours: input.cooldownHours != null ? Number(input.cooldownHours) : undefined,
      skipCurrentCapability: input.includeAlreadyAttempted !== true,
    });
    return {
      ...result,
      note: result.targets.length
        ? `${result.total} lead(s) need enrichment; showing the ${result.targets.length} weakest. Work each one (find_contacts_on_website → enrich_contacts_apollo → verify_email), save what you find with upsert_contact/upsert_lead, then ALWAYS call record_enrichment_attempt so it isn't re-worked next run.`
        : 'Nothing to enrich under these filters — either everything is already well enriched, or every weak lead was already worked with the current capabilities (capability v' +
          result.capabilityVersion +
          '). Do not re-research them; move to outreach.',
    };
  },

  record_enrichment_attempt: async (input, ctx) => {
    const outcome = ['improved', 'no_new_data', 'blocked'].includes(String(input.outcome))
      ? (String(input.outcome) as 'improved' | 'no_new_data' | 'blocked')
      : 'no_new_data';
    const result = await recordEnrichmentAttempt(ctx.organizationId, String(input.leadId), outcome);
    if (!result) throw new Error(`Lead ${input.leadId} not found`);

    if (input.notes) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: String(input.leadId),
        type: 'RESEARCH',
        summary: `Enrichment pass (${outcome}): ${String(input.notes).slice(0, 400)}`,
        agentRunId: ctx.runId,
      });
    }

    return {
      leadId: input.leadId,
      outcome,
      tierBefore: result.tierBefore,
      tier: result.tier,
      score: result.score,
      emailCount: result.emailCount,
      phoneCount: result.phoneCount,
      stillMissing: result.gaps,
      capabilityVersion: ENRICHMENT_CAPABILITY_VERSION,
      note:
        result.tier === 'GOOD' || result.tier === 'RICH'
          ? 'This lead is now well enriched — hand it to outreach and do not research it again.'
          : `Recorded at capability v${ENRICHMENT_CAPABILITY_VERSION}. It will stay off the enrichment work list until the platform gains new enrichment abilities.`,
    };
  },

  upsert_lead: async (input, ctx) => {
    const { lead, created } = await leadService.upsertLead(ctx.organizationId, {
      ...(input as import('../services/lead.service').UpsertLeadInput),
      source: 'web_research',
    });
    if (created) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: lead.id,
        type: 'RESEARCH',
        summary: `Lead created by the Engine${input.groupName ? ` in group "${input.groupName}"` : ''}`,
        agentRunId: ctx.runId,
      });
    }
    return { leadId: lead.id, companyName: lead.companyName, created, mergedIntoExisting: !created };
  },

  find_contacts_on_website: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    if (!lead.website) {
      return { emails: [], phones: [], note: 'This lead has no website on file — research one first (search_web / source_local_businesses usually provide it).' };
    }
    const found = await crawlSiteForContacts(lead.website);
    return {
      ...found,
      note:
        found.emails.length === 0
          ? 'No emails published on the crawled pages. Try browse_web for JS-heavy sites, or enrich_contacts_apollo.'
          : 'Save useful people via upsert_contact. Website-published emails are usually live, but verify_email before high-volume sends.',
    };
  },

  enrich_contacts_apollo: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    const orgConfig = await getOrgConfig(ctx.organizationId);
    if (!orgConfig.search.apolloApiKey) {
      return { people: [], note: 'Apollo API key not configured (Settings → Integrations). Use find_contacts_on_website or browse_web instead.' };
    }
    const domain = lead.domain || (lead.website ? lead.website.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0] : null);
    if (!domain) {
      return { people: [], note: 'No website/domain on this lead — Apollo searches by company domain. Find the website first.' };
    }
    const titles = Array.isArray(input.titles) && input.titles.length
      ? input.titles.map(String)
      : ['Owner', 'General Manager', 'Sales Manager'];
    const { people, error } = await apolloPeopleSearch(domain, titles, orgConfig.search.apolloApiKey);
    if (error) return { people: [], error };

    // Auto-save people whose emails Apollo actually revealed.
    let saved = 0;
    for (const p of people) {
      if (!p.email || !p.name) continue;
      const [firstName, ...rest] = p.name.split(/\s+/);
      const existing = await prisma.contact.findFirst({
        where: { leadId: lead.id, email: p.email.toLowerCase() },
      });
      if (existing) continue;
      await prisma.contact.create({
        data: {
          organizationId: ctx.organizationId,
          leadId: lead.id,
          firstName: firstName || p.name,
          lastName: rest.join(' ') || null,
          title: p.title || null,
          email: p.email.toLowerCase(),
          socials: p.linkedinUrl ? { linkedin: p.linkedinUrl } : undefined,
          source: 'apollo',
        },
      });
      saved++;
    }
    if (saved > 0) await recomputeLeadEnrichment(lead.id);
    const locked = people.filter((p) => p.emailLocked).length;
    return {
      people,
      saved,
      note: `${saved} contact(s) saved.${locked ? ` ${locked} had locked emails (Apollo credits needed to reveal).` : ''} Apollo emails can be stale — verify_email before cold emailing.`,
    };
  },

  verify_email: async (input, ctx) => {
    const orgConfig = await getOrgConfig(ctx.organizationId);
    if (!orgConfig.mailgun.apiKey) {
      return {
        verdict: 'unavailable',
        reason: 'not_configured',
        note: 'Mailgun is not configured (Settings → Integrations), so no verification ran. Treat the address as UNVERIFIED — do not report it as checked.',
      };
    }
    const email = String(input.email || '').toLowerCase().trim();
    if (!email) throw new Error('email is required');
    const result = await verifyEmailAddress(email, orgConfig.mailgun.apiKey);

    // Suppress undeliverable addresses on matching contacts so send_email
    // refuses them — a pre-send bounce prevented is reputation saved. A
    // confirmed-deliverable address is stamped on emailVerifiedAt (NOT
    // emailStatus, where any value means suppressed) so it counts as the
    // strongest enrichment signal a lead can carry.
    if (result.verdict === 'undeliverable' || result.verdict === 'deliverable') {
      const affected = await prisma.contact.findMany({
        where: { organizationId: ctx.organizationId, email },
        select: { id: true, leadId: true },
      });
      if (affected.length) {
        await prisma.contact.updateMany({
          where: { id: { in: affected.map((c) => c.id) } },
          data:
            result.verdict === 'deliverable'
              ? { emailVerifiedAt: new Date() }
              : { emailStatus: 'undeliverable' },
        });
        for (const leadId of new Set(affected.map((c) => c.leadId))) {
          await recomputeLeadEnrichment(leadId);
        }
      }
    }
    // An 'unavailable' result means the check never ran — surface it as a
    // configuration problem to escalate, never as a quiet green light.
    if (result.verdict === 'unavailable') {
      console.error(
        `[verify_email] validation unavailable (${result.reason}) for org ${ctx.organizationId}: ${result.detail}`
      );
      return {
        ...result,
        note: `Email verification did NOT run — ${result.fix} Until this is fixed, addresses cannot be verified: do not claim any address is checked, and flag this to the user rather than sending cold email to unverified addresses at volume.`,
      };
    }

    return {
      ...result,
      note:
        result.verdict === 'deliverable'
          ? 'Safe to email.'
          : result.verdict === 'undeliverable'
            ? 'Dead address — suppressed. Find another contact or channel.'
            : 'Mailgun checked it but could not decide (catch-all or risky domain) — acceptable to try once, but prefer a deliverable address if available.',
    };
  },

  upsert_contact: async (input, ctx) => {
    await requireLead(input.leadId, ctx.organizationId);
    const email = input.email?.toLowerCase().trim() || null;
    const data = {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      email,
      phone: input.phone ?? null,
      socials: input.socials ? (input.socials as Prisma.InputJsonValue) : undefined,
      isPrimary: !!input.isPrimary,
      source: 'web_research',
    };
    const existing = email
      ? await prisma.contact.findUnique({ where: { leadId_email: { leadId: input.leadId, email } } })
      : await prisma.contact.findFirst({
          where: {
            leadId: input.leadId,
            firstName: { equals: input.firstName, mode: 'insensitive' },
            lastName: { equals: input.lastName ?? '', mode: 'insensitive' },
          },
        });
    const contact = existing
      ? await prisma.contact.update({ where: { id: existing.id }, data })
      : await prisma.contact.create({
          data: { ...data, leadId: input.leadId, organizationId: ctx.organizationId },
        });
    // Saving a person is the main way a lead gets more reachable — re-grade it
    // and tell the agent where the lead now stands.
    const snapshot = await recomputeLeadEnrichment(input.leadId);
    return {
      contactId: contact.id,
      created: !existing,
      ...(snapshot
        ? {
            enrichment: {
              tier: snapshot.tier,
              score: snapshot.score,
              emailCount: snapshot.emailCount,
              phoneCount: snapshot.phoneCount,
              stillMissing: snapshot.gaps,
            },
          }
        : {}),
    };
  },

  get_lead_timeline: async (input, ctx) => {
    const lead = await prisma.lead.findFirst({
      where: { id: input.leadId, organizationId: ctx.organizationId },
      include: {
        group: { select: { name: true } },
        contacts: true,
        activities: { orderBy: { createdAt: 'desc' }, take: Math.min(input.limit || 20, 50) },
      },
    });
    if (!lead) throw new Error(`Lead ${input.leadId} not found`);
    return {
      id: lead.id,
      companyName: lead.companyName,
      status: lead.status,
      group: lead.group?.name,
      aiSummary: lead.aiSummary,
      contacts: lead.contacts.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName || ''}`.trim(),
        title: c.title,
        email: c.email,
        phone: c.phone,
        isPrimary: c.isPrimary,
        optedOut: c.optedOut,
      })),
      timeline: lead.activities.map((a) => ({
        type: a.type,
        summary: a.summary,
        at: a.createdAt.toISOString(),
      })),
    };
  },

  add_note: async (input, ctx) => {
    await requireLead(input.leadId, ctx.organizationId);
    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: input.leadId,
      type: 'NOTE',
      summary: input.note,
      agentRunId: ctx.runId,
    });
    return { ok: true };
  },

  update_lead_status: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: input.status } });
    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'STATUS_CHANGE',
      summary: `Status changed from ${lead.status} to ${input.status}${input.reason ? ` — ${input.reason}` : ''}`,
      agentRunId: ctx.runId,
    });
    // Alert humans when a lead turns hot (newly INTERESTED).
    if (input.status === 'INTERESTED' && lead.status !== 'INTERESTED') {
      await notify({
        organizationId: ctx.organizationId,
        type: 'LEAD_INTERESTED',
        title: `Lead interested: ${lead.companyName}`,
        body: input.reason || 'The Engine marked this lead as interested.',
        leadId: lead.id,
        emailAlert: true,
      });
    }
    return { ok: true, previousStatus: lead.status, status: input.status };
  },

  create_campaign: async (input, ctx) => {
    let autoEnrollGroupId: string | undefined;
    if (input.autoEnrollGroupName) {
      const group = await prisma.leadGroup.findUnique({
        where: {
          organizationId_name: {
            organizationId: ctx.organizationId,
            name: input.autoEnrollGroupName,
          },
        },
      });
      if (!group) {
        throw new Error(
          `No lead group named "${input.autoEnrollGroupName}" — create it first (create_lead_group) or check the name with search_leads.`
        );
      }
      autoEnrollGroupId = group.id;
    }
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        offer: input.offer,
        channels: input.channels || ['EMAIL'],
        mode: input.mode || 'APPROVAL_REQUIRED',
        followUpCadenceDays: input.followUpCadenceDays ?? 3,
        maxTouches: input.maxTouches ?? 6,
        autoEnrollGroupId,
      },
    });
    return {
      campaignId: campaign.id,
      name: campaign.name,
      mode: campaign.mode,
      ...(autoEnrollGroupId
        ? {
            autoEnroll: `Leads in group "${input.autoEnrollGroupName}" will be enrolled automatically (checked every few minutes once the campaign is ACTIVE).`,
          }
        : {}),
    };
  },

  add_leads_to_campaign: async (input, ctx) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: input.campaignId, organizationId: ctx.organizationId },
    });
    if (!campaign) throw new Error('Campaign not found');
    const leads = await prisma.lead.findMany({
      where: { id: { in: input.leadIds }, organizationId: ctx.organizationId },
      select: { id: true },
    });
    const result = await prisma.campaignLead.createMany({
      data: leads.map((l) => ({ campaignId: campaign.id, leadId: l.id })),
      skipDuplicates: true,
    });
    return { enrolled: result.count, requested: input.leadIds.length };
  },

  send_email: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    assertContactable(lead);
    const contact = input.contactId
      ? await prisma.contact.findFirst({ where: { id: input.contactId, leadId: lead.id } })
      : await prisma.contact.findFirst({
          where: { leadId: lead.id, email: { not: null }, optedOut: false, emailStatus: null },
          orderBy: { isPrimary: 'desc' },
        });
    if (!contact?.email) {
      return { sent: false, reason: 'No contact with an email address on this lead. Research one first.' };
    }
    if (contact.optedOut) return { sent: false, reason: 'Contact has opted out — do not message them.' };
    if (contact.emailStatus) {
      return { sent: false, reason: `This email previously ${contact.emailStatus} — address suppressed. Try another contact or channel.` };
    }

    const orgConfig = await getOrgConfig(ctx.organizationId);
    const blocked = await outboundBlockReason(ctx.organizationId, lead);
    const draftReason = await draftOnlyReason(
      input.campaignId,
      ctx.organizationId,
      blocked,
      channels.isEmailConfigured(orgConfig.mailgun)
    );

    if (draftReason) {
      const result = await recordOutbound({
        ctx,
        leadId: lead.id,
        contactId: contact.id,
        channel: 'EMAIL',
        subject: input.subject,
        body: input.body,
        campaignId: input.campaignId,
        status: blocked ? 'draft_blocked' : 'draft_pending_approval',
        activityType: 'EMAIL_SENT',
        activitySummary: `Email drafted to ${contact.email}: "${input.subject}"`,
      });
      return { sent: false, drafted: true, ...result, note: draftReason };
    }

    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    const delivery = await channels.sendEmail(
      {
        to: contact.email,
        subject: input.subject,
        body: input.body,
        fromName: org?.name,
        // One-click unsubscribe (List-Unsubscribe header) — deliverability + CAN-SPAM.
        unsubscribeUrl: `${config.appPublicUrl}/api/public/unsubscribe?c=${signToken(contact.id)}`,
      },
      orgConfig.mailgun
    );
    if (!delivery.sent) {
      return { sent: false, reason: `Email delivery failed: ${delivery.error}` };
    }
    const result = await recordOutbound({
      ctx,
      leadId: lead.id,
      contactId: contact.id,
      channel: 'EMAIL',
      subject: input.subject,
      body: input.body,
      campaignId: input.campaignId,
      status: 'sent',
      activityType: 'EMAIL_SENT',
      activitySummary: `Email sent to ${contact.email}: "${input.subject}"`,
      experimentVariantId: input.experimentVariantId,
      externalId: delivery.externalId,
    });
    return { sent: true, to: contact.email, externalId: delivery.externalId, ...result };
  },

  send_sms: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    assertContactable(lead);
    const contact = input.contactId
      ? await prisma.contact.findFirst({ where: { id: input.contactId, leadId: lead.id } })
      : await prisma.contact.findFirst({
          where: { leadId: lead.id, phone: { not: null }, optedOut: false },
          orderBy: { isPrimary: 'desc' },
        });
    if (!contact?.phone) {
      return { sent: false, reason: 'No contact with a phone number on this lead. Research one first.' };
    }
    if (contact.optedOut) return { sent: false, reason: 'Contact has opted out — do not message them.' };

    const orgConfig = await getOrgConfig(ctx.organizationId);
    const blocked = await outboundBlockReason(ctx.organizationId, lead);
    const draftReason = await draftOnlyReason(
      input.campaignId,
      ctx.organizationId,
      blocked,
      channels.isSmsConfigured(orgConfig.twilio),
      'sms'
    );

    if (draftReason) {
      const result = await recordOutbound({
        ctx,
        leadId: lead.id,
        contactId: contact.id,
        channel: 'SMS',
        body: input.body,
        campaignId: input.campaignId,
        status: blocked ? 'draft_blocked' : 'draft_pending_approval',
        activityType: 'SMS_SENT',
        activitySummary: `SMS drafted to ${contact.phone}`,
      });
      return { sent: false, drafted: true, ...result, note: draftReason };
    }

    const delivery = await channels.sendSms({ to: contact.phone, body: input.body }, orgConfig.twilio);
    if (!delivery.sent) {
      return { sent: false, reason: `SMS delivery failed: ${delivery.error}` };
    }
    const result = await recordOutbound({
      ctx,
      leadId: lead.id,
      contactId: contact.id,
      channel: 'SMS',
      body: input.body,
      campaignId: input.campaignId,
      status: 'sent',
      activityType: 'SMS_SENT',
      activitySummary: `SMS sent to ${contact.phone}`,
      experimentVariantId: input.experimentVariantId,
      externalId: delivery.externalId,
    });
    return { sent: true, to: contact.phone, externalId: delivery.externalId, ...result };
  },

  place_call: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    assertContactable(lead);
    const contact = input.contactId
      ? await prisma.contact.findFirst({ where: { id: input.contactId, leadId: lead.id } })
      : await prisma.contact.findFirst({
          where: { leadId: lead.id, phone: { not: null }, optedOut: false },
          orderBy: { isPrimary: 'desc' },
        });
    const toNumber = contact?.phone || lead.phone;
    if (!toNumber) {
      return { called: false, reason: 'No phone number on this lead or its contacts. Research one first.' };
    }
    if (contact?.optedOut) return { called: false, reason: 'Contact has opted out — do not call them.' };

    const blocked = await outboundBlockReason(ctx.organizationId, lead);
    if (blocked) return { called: false, reason: blocked };

    const orgConfig = await getOrgConfig(ctx.organizationId);
    if (!channels.isVoiceConfigured(orgConfig.vapi)) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: lead.id,
        type: 'CALL_PLACED',
        summary: `AI call intent recorded (voice channel not configured): ${input.objective}`,
        payload: { objective: input.objective, status: 'pending_channel_setup' },
        campaignId: input.campaignId,
        agentRunId: ctx.runId,
      });
      return {
        called: false,
        note: 'Voice channel (Vapi) is not configured — intent recorded on the lead timeline.',
      };
    }

    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    const recentActivities = await prisma.activity.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const voicePlaybooks = await getVoicePlaybookText(ctx.organizationId);
    const contactName = contact ? `${contact.firstName} ${contact.lastName || ''}`.trim() : undefined;

    const systemPrompt = buildCallSystemPrompt({
      organizationName: org?.name || 'our company',
      objective: input.objective,
      lead: {
        companyName: lead.companyName,
        contactName,
        status: lead.status,
        aiSummary: lead.aiSummary,
        recentTimeline: recentActivities.map((a) => `${a.type}: ${a.summary}`),
      },
      voicePlaybooks,
    });
    const firstMessage = `Hi${contactName ? ` ${contactName.split(' ')[0]}` : ''}, this is the assistant calling on behalf of ${org?.name || 'our team'} — do you have a quick minute?`;

    const voicemailMessage =
      input.voicemailMessage ||
      `Hi, this is the assistant calling from ${org?.name || 'our office'} for ${lead.companyName}. Sorry we missed you — we'll follow up by text or email shortly. Have a great day!`;
    const delivery = await channels.placeVapiCall(
      {
        toNumber,
        systemPrompt,
        firstMessage,
        voicemailMessage,
        metadata: {
          organizationId: ctx.organizationId,
          leadId: lead.id,
          agentRunId: ctx.runId,
          ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        },
        // Tell Vapi to POST the end-of-call report to our webhook — no Vapi
        // dashboard Server URL config needed.
        ...(orgConfig.vapi.webhookSecret
          ? { server: { url: `${config.appPublicUrl}/api/webhooks/vapi`, secret: orgConfig.vapi.webhookSecret } }
          : {}),
      },
      orgConfig.vapi
    );
    if (!delivery.sent) {
      return { called: false, reason: `Call placement failed: ${delivery.error}` };
    }

    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'CALL_PLACED',
      summary: `AI call placed to ${toNumber}: ${input.objective}`,
      payload: { objective: input.objective, vapiCallId: delivery.externalId, to: toNumber },
      campaignId: input.campaignId,
      agentRunId: ctx.runId,
    });
    if (input.campaignId) {
      await recordCampaignTouch(input.campaignId, lead.id);
    }
    return {
      called: true,
      to: toNumber,
      vapiCallId: delivery.externalId,
      note: 'Call in progress — the transcript and outcome will appear on the lead timeline when the call ends.',
    };
  },

  browse_web: async (input, ctx) => {
    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    const orgConfig = await getOrgConfig(ctx.organizationId);
    const model = org?.engineModel || config.engine.model;
    const platform = input.platform as PlatformKey | undefined;
    const storageState = platform
      ? (await loadStorageState(ctx.organizationId, platform)) || undefined
      : undefined;
    const result = await runBrowserAgent({
      objective: input.objective,
      startUrl: input.startUrl,
      model,
      providerKeys: orgConfig.providerKeys,
      allowSend: false,
      storageState,
      onStep: (n) => recordBrowserAction(ctx.runId, ctx.organizationId, n),
      onFrame: (f) => recordBrowserFrame(ctx.runId, ctx.organizationId, f),
      ...(platform && storageState
        ? { persistState: (state) => saveStorageState(ctx.organizationId, platform, state) }
        : {}),
    });
    await attributeBrowserUsage(ctx.runId, result.usage);
    if (input.leadId) {
      await prisma.lead
        .findFirst({ where: { id: input.leadId, organizationId: ctx.organizationId } })
        .then((lead) => {
          if (!lead) return;
          return leadService.logActivity({
            organizationId: ctx.organizationId,
            leadId: lead.id,
            type: 'RESEARCH',
            summary: `Browser research: ${result.summary}`.slice(0, 500),
            payload: { objective: input.objective, data: result.data, finalUrl: result.finalUrl },
            agentRunId: ctx.runId,
          });
        });
    }
    return {
      status: result.status,
      summary: result.summary,
      data: result.data,
      steps: result.steps,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  find_business_page: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    const platform = input.platform as PlatformKey;
    const socials = (lead.socials || {}) as Record<string, string>;
    if (socials[platform]) {
      return {
        alreadyKnown: true,
        url: socials[platform],
        note: `Already on file for ${platform}. Message it with send_social_dm (target: business_page).`,
      };
    }

    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    const orgConfig = await getOrgConfig(ctx.organizationId);
    const storageState = (await loadStorageState(ctx.organizationId, platform)) || undefined;

    // Verification criteria are spelled out because a wrong page means DMing a
    // different business entirely — worse than finding nothing.
    const identity = [
      `Company name: ${lead.companyName}`,
      lead.city || lead.state ? `Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}` : null,
      lead.website ? `Website: ${lead.website}` : null,
      lead.phone ? `Phone: ${lead.phone}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await runBrowserAgent({
      objective: `Find the OFFICIAL ${platform} page for this business — the company's own page/account, NOT an employee's personal profile and NOT a fan/unofficial page.

${identity}

Confirm the page is genuinely this business before reporting it. Evidence that counts: the page name matches the company; the listed address/city matches; the page links to the website above; the phone matches; the bio describes the same business. A same-name business in a DIFFERENT city is NOT a match — dealership names repeat across regions.

Finish with: the page URL, whether it has a message/DM button, and exactly which evidence you matched on. If you cannot confirm a match, say so plainly rather than guessing.`,
      model: org?.engineModel || config.engine.model,
      providerKeys: orgConfig.providerKeys,
      allowSend: false,
      storageState,
      onStep: (n) => recordBrowserAction(ctx.runId, ctx.organizationId, n),
      onFrame: (f) => recordBrowserFrame(ctx.runId, ctx.organizationId, f),
      ...(storageState
        ? { persistState: (state) => saveStorageState(ctx.organizationId, platform, state) }
        : {}),
    });
    await attributeBrowserUsage(ctx.runId, result.usage);

    const data = (result.data || {}) as Record<string, unknown>;
    const url = typeof data.url === 'string' ? data.url : typeof data.pageUrl === 'string' ? data.pageUrl : null;
    const found = result.status === 'completed' && !!url;

    if (found) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { socials: { ...socials, [platform]: url } as Prisma.InputJsonValue },
      });
      // A social channel changes how reachable this lead is — re-grade it.
      await recomputeLeadEnrichment(lead.id);
    }

    await leadService.logActivity({
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: 'RESEARCH',
      summary: `${platform} business page ${found ? `found: ${url}` : 'not confirmed'} — ${result.summary}`.slice(0, 500),
      payload: { platform, url, evidence: result.data, kind: 'business_page' },
      agentRunId: ctx.runId,
    });

    return {
      found,
      url,
      platform,
      evidence: result.data,
      summary: result.summary,
      note: found
        ? 'Saved to the lead. DM this page first (send_social_dm with target business_page) — only go looking for individual people if the page has no DM option or does not reply.'
        : 'No confirmed page. Either this business has none, or the match was too uncertain to trust — do not save a guess. Try the other platform, or move to finding a person.',
    };
  },

  send_social_dm: async (input, ctx) => {
    const lead = await requireLead(input.leadId, ctx.organizationId);
    assertContactable(lead);

    // Business page first: it's the company's own inbox, so there is no
    // identity guesswork and no wrong-person risk. Default to it whenever one
    // is on file and no specific person was named.
    const leadSocials = (lead.socials || {}) as Record<string, string>;
    const pageUrl = leadSocials[String(input.platform)];
    const target: 'business_page' | 'person' =
      input.target === 'person' || input.target === 'business_page'
        ? input.target
        : !input.profileUrl && !input.personName && pageUrl
          ? 'business_page'
          : 'person';

    // One cold DM per lead per platform PER TARGET — repeats waste quota, look
    // spammy, and risk the account. Scoping by target is what lets the page get
    // the first touch without spending the individual's allowance.
    if (!input.allowRepeat) {
      const priorTouch = await prisma.activity.findFirst({
        where: {
          organizationId: ctx.organizationId,
          leadId: lead.id,
          type: 'SOCIAL_TOUCH',
          AND: [
            { payload: { path: ['platform'], equals: input.platform } },
            { payload: { path: ['target'], equals: target } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (priorTouch) {
        return {
          sent: false,
          skipped: true,
          note: `This lead already got a ${input.platform} DM to the ${target.replace('_', ' ')} (${priorTouch.createdAt.toISOString().slice(0, 10)}). Cold DM = one per target; if they replied, reply via the conversation instead.${target === 'business_page' ? ' You may still try a named person at this company with target "person".' : ''}`,
        };
      }
    }

    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });

    const blocked = await outboundBlockReason(ctx.organizationId, lead);
    const model = org?.engineModel || config.engine.model;

    const recordTouch = async (status: string, summary: string, extra?: Record<string, unknown>) => {
      const conversation =
        (await prisma.conversation.findFirst({
          where: { leadId: lead.id, channel: 'SOCIAL' },
        })) ??
        (await prisma.conversation.create({
          data: {
            organizationId: ctx.organizationId,
            leadId: lead.id,
            channel: 'SOCIAL',
            subject: `${input.platform} DM`,
          },
        }));
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          body: input.message,
          status,
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: lead.id,
        type: 'SOCIAL_TOUCH',
        summary,
        // `target` is what scopes the one-cold-DM rule, so it must be recorded
        // on every touch — including drafts, which also consume the allowance.
        payload: { platform: input.platform, target, status, message: input.message, ...extra },
        agentRunId: ctx.runId,
      });
      return conversation.id;
    };

    // Draft-first unless the org has explicitly enabled autonomous social.
    if (blocked || !org?.socialAutonomy) {
      const reason = blocked
        ? blocked
        : 'Autonomous social messaging is off (platform ToS risk). DM saved as a draft for approval — enable social autonomy in Settings to send.';
      await recordTouch('draft_pending_approval', `${input.platform} DM drafted for approval`);
      return { sent: false, drafted: true, note: reason };
    }

    const platform = input.platform as PlatformKey;
    const storageState = await loadStorageState(ctx.organizationId, platform);
    if (!storageState) {
      await recordTouch(
        'draft_pending_approval',
        `${input.platform} DM drafted — no connected ${input.platform} account`
      );
      return {
        sent: false,
        drafted: true,
        note: `No connected ${input.platform} account. Connect one in Settings → Social accounts (log in once), then I can send without logging in per lead.`,
      };
    }

    // Messaging a company page and messaging a person are different jobs: the
    // page needs no identity check, while a personal profile must be confirmed
    // as the right human before anything is sent.
    const startUrl = input.profileUrl || (target === 'business_page' ? pageUrl : undefined);
    const destination =
      target === 'business_page'
        ? `the OFFICIAL ${lead.companyName} business page${pageUrl ? ` at ${pageUrl}` : ''} (the company's own page, not an employee's personal profile)`
        : input.profileUrl
          ? `their profile at ${input.profileUrl}`
          : `${input.personName || 'the decision maker'} at ${lead.companyName}`;
    const verification =
      target === 'business_page'
        ? `Confirm the page really is ${lead.companyName}${lead.city ? ` in ${lead.city}` : ''} before messaging — same-name businesses in other cities are NOT the right page.`
        : `Confirm this is the right person before messaging: the profile should tie them to ${lead.companyName}${lead.city ? ` in ${lead.city}` : ''} via their bio, employer, or posts. If you cannot confirm it is the right person, do NOT send — finish and report what you found instead.`;
    const objective = `You are already logged in to ${input.platform}. Find ${destination} and send this direct message, personalized naturally: "${input.message}". ${verification} Confirm the message was sent.`;

    const orgConfig = await getOrgConfig(ctx.organizationId);
    const result = await runBrowserAgent({
      objective,
      startUrl,
      model,
      providerKeys: orgConfig.providerKeys,
      allowSend: true,
      storageState,
      persistState: (state) => saveStorageState(ctx.organizationId, platform, state),
      onStep: (n) => recordBrowserAction(ctx.runId, ctx.organizationId, n),
      onFrame: (f) => recordBrowserFrame(ctx.runId, ctx.organizationId, f),
    });
    await attributeBrowserUsage(ctx.runId, result.usage);

    const success = result.status === 'completed';
    await recordTouch(
      success ? 'sent' : 'failed',
      `${input.platform} DM ${success ? 'sent' : 'attempt failed'}: ${result.summary}`.slice(0, 500),
      { browserResult: result.summary, finalUrl: result.finalUrl }
    );
    return {
      sent: success,
      summary: result.summary,
      steps: result.steps,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  check_social_inbox: async (input, ctx) => {
    const platform = input.platform as PlatformKey;
    const result = await sweepSocialInbox(ctx.organizationId, platform);
    if (result.status === 'skipped') {
      return { checked: false, note: result.error };
    }
    return {
      checked: true,
      newReplies: result.found,
      matchedToLeads: result.matched,
      unrecognizedSenders: result.unmatched,
      note:
        result.status === 'failed'
          ? `Sweep failed: ${result.error}`
          : 'Matched replies are already ingested — each lead conversation is updated and an SDR job is queued to respond. Do not re-read or re-ingest them.',
    };
  },

  schedule_followup: async (input, ctx) => {
    let runAt: Date;
    if (input.runAtIso) {
      runAt = new Date(input.runAtIso);
      if (isNaN(runAt.getTime())) throw new Error(`Invalid runAtIso: ${input.runAtIso}`);
    } else {
      runAt = new Date(Date.now() + (input.delayHours ?? 24) * 3600 * 1000);
    }
    if (input.leadId) await requireLead(input.leadId, ctx.organizationId);

    const type = input.type || 'FOLLOW_UP';
    const role = (input.role as AgentRole | undefined) || defaultRoleForJobType(type);
    const job = await prisma.agentJob.create({
      data: {
        organizationId: ctx.organizationId,
        type,
        role,
        objective: input.objective,
        leadId: input.leadId,
        campaignId: input.campaignId,
        runAt,
        createdByRunId: ctx.runId,
      },
    });
    if (input.leadId) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: input.leadId,
        type: 'FOLLOW_UP_SCHEDULED',
        summary: `Follow-up scheduled for ${runAt.toISOString()}`,
        agentRunId: ctx.runId,
      });
    }
    return { jobId: job.id, runAt: runAt.toISOString() };
  },

  list_calendar_events: async (input, ctx) => {
    const start = input.startIso ? new Date(input.startIso) : new Date();
    if (isNaN(start.getTime())) throw new Error(`Invalid startIso: ${input.startIso}`);
    const end = input.endIso
      ? new Date(input.endIso)
      : new Date(start.getTime() + 14 * 24 * 3600 * 1000);
    if (isNaN(end.getTime())) throw new Error(`Invalid endIso: ${input.endIso}`);

    const events = await prisma.calendarEvent.findMany({
      where: {
        organizationId: ctx.organizationId,
        startAt: { gte: start, lte: end },
        ...(input.leadId ? { leadId: input.leadId } : {}),
      },
      include: {
        lead: { select: { companyName: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startAt: 'asc' },
      take: 100,
    });
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        type: e.type,
        status: e.status,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt?.toISOString() ?? null,
        allDay: e.allDay,
        location: e.location,
        lead: e.lead?.companyName,
        contact: e.contact ? `${e.contact.firstName} ${e.contact.lastName || ''}`.trim() : null,
      })),
    };
  },

  get_booking_links: async (_input, ctx) => {
    const links = await prisma.bookingLink.findMany({
      where: { organizationId: ctx.organizationId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (links.length === 0) {
      return {
        links: [],
        note: 'No booking links set up yet. Create one in Settings → Booking links, then share it with interested leads.',
      };
    }
    return {
      links: links.map((l) => ({
        title: l.title,
        url: `${config.appPublicUrl}/book/${l.slug}`,
        durationMinutes: l.durationMinutes,
      })),
    };
  },

  create_calendar_event: async (input, ctx) => {
    const startAt = new Date(input.startAtIso);
    if (isNaN(startAt.getTime())) throw new Error(`Invalid startAtIso: ${input.startAtIso}`);
    const endAt = input.endAtIso ? new Date(input.endAtIso) : null;
    if (endAt && isNaN(endAt.getTime())) throw new Error(`Invalid endAtIso: ${input.endAtIso}`);
    if (input.leadId) await requireLead(input.leadId, ctx.organizationId);
    if (input.contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: input.contactId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!contact) throw new Error(`Contact ${input.contactId} not found in this organization`);
    }

    const event = await prisma.calendarEvent.create({
      data: {
        organizationId: ctx.organizationId,
        title: input.title,
        description: input.description,
        location: input.location,
        type: input.type || 'MEETING',
        startAt,
        endAt,
        allDay: !!input.allDay,
        leadId: input.leadId,
        contactId: input.contactId,
        createdByRunId: ctx.runId,
      },
    });
    if (input.leadId) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: input.leadId,
        type: 'NOTE',
        summary: `${event.type} booked: "${event.title}" at ${startAt.toISOString()}`,
        payload: { calendarEventId: event.id },
        agentRunId: ctx.runId,
      });
    }
    // Alert the humans — a booked meeting is the whole point of the platform.
    await notify({
      organizationId: ctx.organizationId,
      type: 'MEETING_BOOKED',
      title: `Meeting booked: ${event.title}`,
      body: `${event.type} scheduled for ${startAt.toUTCString()}.`,
      leadId: input.leadId,
      emailAlert: true,
    });
    return { eventId: event.id, startAt: startAt.toISOString(), title: event.title };
  },

  update_calendar_event: async (input, ctx) => {
    const existing = await prisma.calendarEvent.findFirst({
      where: { id: input.eventId, organizationId: ctx.organizationId },
    });
    if (!existing) throw new Error(`Calendar event ${input.eventId} not found`);

    const data: Record<string, unknown> = {};
    if (input.title) data.title = input.title;
    if (input.location !== undefined) data.location = input.location;
    if (input.description !== undefined) data.description = input.description;
    if (input.status) data.status = input.status;
    if (input.startAtIso) {
      const startAt = new Date(input.startAtIso);
      if (isNaN(startAt.getTime())) throw new Error(`Invalid startAtIso: ${input.startAtIso}`);
      data.startAt = startAt;
    }
    if (input.endAtIso) {
      const endAt = new Date(input.endAtIso);
      if (isNaN(endAt.getTime())) throw new Error(`Invalid endAtIso: ${input.endAtIso}`);
      data.endAt = endAt;
    }
    const event = await prisma.calendarEvent.update({ where: { id: existing.id }, data });
    if (existing.leadId) {
      await leadService.logActivity({
        organizationId: ctx.organizationId,
        leadId: existing.leadId,
        type: 'NOTE',
        summary:
          input.status === 'CANCELLED'
            ? `Event cancelled: "${existing.title}"`
            : `Event updated: "${event.title}" now at ${event.startAt.toISOString()} (${event.status})`,
        payload: { calendarEventId: event.id },
        agentRunId: ctx.runId,
      });
    }
    return { eventId: event.id, status: event.status, startAt: event.startAt.toISOString() };
  },

  list_playbooks: async (_input, ctx) => {
    const playbooks = await prisma.playbook.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      playbooks: playbooks.map((p) => ({
        id: p.id,
        name: p.name,
        scope: p.scope,
        channel: p.channel,
        isActive: p.isActive,
        instructions: p.instructions,
      })),
    };
  },

  edit_playbook_text: async (input, ctx) => {
    try {
      const { after } = await strReplaceInPlaybook(
        ctx.organizationId,
        input.playbookId,
        input.find,
        input.replace
      );
      return { ok: true, updatedInstructions: after };
    } catch (err) {
      if (err instanceof PlaybookEditError) return { ok: false, error: err.message };
      throw err;
    }
  },

  append_playbook: async (input, ctx) => {
    try {
      const updated = await appendToPlaybook(ctx.organizationId, input.playbookId, input.text);
      return { ok: true, updatedInstructions: updated };
    } catch (err) {
      if (err instanceof PlaybookEditError) return { ok: false, error: err.message };
      throw err;
    }
  },

  create_playbook: async (input, ctx) => {
    const name = String(input.name || '').trim();
    const instructions = String(input.instructions || '').trim();
    if (!name) throw new Error('A playbook name is required.');
    if (!instructions) throw new Error('Playbook instructions are required.');

    const LEAD_STATUSES = ['NEW', 'RESEARCHING', 'CONTACTED', 'ENGAGED', 'INTERESTED', 'NOT_INTERESTED', 'CUSTOMER', 'ARCHIVED'];
    const VALID_CHANNELS = ['ALL', 'EMAIL', 'SMS', 'VOICE'];
    const channel = VALID_CHANNELS.includes(input.channel) ? input.channel : 'ALL';

    // Resolve the scope target defensively — a slightly-off scope/target from
    // the model must NOT crash the create; fall back to GLOBAL and note it.
    let scope: string = ['GLOBAL', 'GROUP', 'CAMPAIGN', 'LEAD_STATUS'].includes(input.scope) ? input.scope : 'GLOBAL';
    let groupId: string | undefined;
    let campaignId: string | undefined;
    let leadStatus: string | undefined;
    const notes: string[] = [];

    if (scope === 'GROUP') {
      const groupName = String(input.groupName || '').trim();
      if (input.groupId) {
        const g = await prisma.leadGroup.findFirst({ where: { id: input.groupId, organizationId: ctx.organizationId }, select: { id: true } });
        if (g) groupId = g.id;
      }
      if (!groupId && groupName) {
        const g = await prisma.leadGroup.upsert({
          where: { organizationId_name: { organizationId: ctx.organizationId, name: groupName } },
          create: { organizationId: ctx.organizationId, name: groupName },
          update: {},
        });
        groupId = g.id;
      }
      if (!groupId) { scope = 'GLOBAL'; notes.push('no valid group given — made it a global playbook'); }
    } else if (scope === 'CAMPAIGN') {
      if (input.campaignId) {
        const c = await prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: ctx.organizationId }, select: { id: true } });
        if (c) campaignId = c.id;
      }
      if (!campaignId) { scope = 'GLOBAL'; notes.push('no valid campaign given — made it a global playbook'); }
    } else if (scope === 'LEAD_STATUS') {
      const st = String(input.leadStatus || '').toUpperCase();
      if (LEAD_STATUSES.includes(st)) leadStatus = st;
      else { scope = 'GLOBAL'; notes.push(`"${input.leadStatus}" is not a valid lead status — made it a global playbook`); }
    }

    const playbook = await prisma.playbook.create({
      data: {
        organizationId: ctx.organizationId,
        name,
        instructions,
        scope: scope as never,
        groupId,
        campaignId,
        leadStatus: leadStatus as never,
        channel: channel as never,
      },
    });
    return {
      playbookId: playbook.id,
      name: playbook.name,
      scope: playbook.scope,
      channel: playbook.channel,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    };
  },

  set_playbook_active: async (input, ctx) => {
    const existing = await prisma.playbook.findFirst({
      where: { id: input.playbookId, organizationId: ctx.organizationId },
    });
    if (!existing) throw new Error('Playbook not found');
    await prisma.playbook.update({
      where: { id: existing.id },
      data: { isActive: !!input.isActive },
    });
    return { ok: true, isActive: !!input.isActive };
  },

  create_experiment: async (input, ctx) => {
    const experiment = await prisma.experiment.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        channel: input.channel,
        goal: input.goal,
        campaignId: input.campaignId,
        variants: {
          create: (input.variants as { label: string; content: string; weight?: number }[]).map(
            (v) => ({ label: v.label, content: v.content, weight: v.weight ?? 1 })
          ),
        },
      },
      include: { variants: true },
    });
    return {
      experimentId: experiment.id,
      variants: experiment.variants.map((v) => ({ id: v.id, label: v.label })),
    };
  },

  list_experiments: async (_input, ctx) => {
    const experiments = await prisma.experiment.findMany({
      where: { organizationId: ctx.organizationId },
      include: { variants: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      experiments: experiments.map((e) => ({
        id: e.id,
        name: e.name,
        channel: e.channel,
        status: e.status,
        goal: e.goal,
        variants: e.variants.map(summarizeVariant),
      })),
    };
  },

  pick_experiment_variant: async (input, ctx) => {
    const picked = await pickVariant(input.experimentId, ctx.organizationId);
    if (!picked) return { error: 'Experiment not found or not active' };
    return {
      experimentVariantId: picked.variant.id,
      label: picked.variant.label,
      content: picked.variant.content,
    };
  },

  conclude_experiment: async (input, ctx) => {
    const experiment = await prisma.experiment.findFirst({
      where: { id: input.experimentId, organizationId: ctx.organizationId },
    });
    if (!experiment) throw new Error('Experiment not found');
    await prisma.experiment.update({
      where: { id: experiment.id },
      data: { status: 'COMPLETED', winnerVariantId: input.winnerVariantId || null },
    });
    const results = await getExperimentResults(experiment.id, ctx.organizationId);
    return { ok: true, results };
  },

  explain_platform: async (input) => {
    const topic = input.topic as string | undefined;
    if (topic && PLATFORM_GUIDE[topic]) {
      return { topic, guide: PLATFORM_GUIDE[topic] };
    }
    return { topics: GUIDE_TOPICS, guide: PLATFORM_GUIDE };
  },

  get_setup_status: async (_input, ctx) => {
    const orgConfig = await getOrgConfig(ctx.organizationId);
    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
    const [playbooks, activeCampaigns, bookingLinks, leads, socialAccounts, contactsWithEmail] =
      await Promise.all([
        prisma.playbook.count({ where: { organizationId: ctx.organizationId, isActive: true } }),
        prisma.campaign.count({ where: { organizationId: ctx.organizationId, status: 'ACTIVE' } }),
        prisma.bookingLink.count({ where: { organizationId: ctx.organizationId, active: true } }),
        prisma.lead.count({ where: { organizationId: ctx.organizationId } }),
        prisma.socialAccount.count({
          where: { organizationId: ctx.organizationId, status: 'CONNECTED' },
        }),
        prisma.contact.count({
          where: { organizationId: ctx.organizationId, email: { not: null }, optedOut: false },
        }),
      ]);

    const configured = {
      aiProvider: llmService.isAnyProviderConfigured(orgConfig.providerKeys),
      email: channels.isEmailConfigured(orgConfig.mailgun),
      sms: channels.isSmsConfigured(orgConfig.twilio),
      voice: channels.isVoiceConfigured(orgConfig.vapi),
      webSearch: !!orgConfig.search.apiKey,
      placesSourcing: !!orgConfig.search.googlePlacesApiKey,
      apolloEnrichment: !!orgConfig.search.apolloApiKey,
      socialAccountsConnected: socialAccounts,
    };
    const suggestions: string[] = [];
    if (!configured.aiProvider) suggestions.push('Add at least one AI provider API key (Settings → Integrations) — nothing runs without it.');
    if (!configured.email) suggestions.push('Configure Mailgun (API key + domain) to enable email outreach, calendar invites, and notifications.');
    if (!configured.sms) suggestions.push('Configure Twilio to enable SMS touches.');
    if (!configured.voice) suggestions.push('Configure Vapi (incl. webhook secret) to enable AI voice calls.');
    if (!configured.placesSourcing) suggestions.push('Add a Google Places API key for systematic lead sourcing.');
    if (!configured.apolloEnrichment) suggestions.push('Add an Apollo API key for decision-maker enrichment (optional — website crawl works without it).');
    if (playbooks === 0) suggestions.push('Create playbooks: outreach tone/rules, objection handling, a VOICE call script.');
    if (bookingLinks === 0) suggestions.push('Create a booking link so leads can self-schedule (create_booking_link).');
    if (activeCampaigns === 0) suggestions.push('Create and activate a campaign to start the outreach cadence.');
    if (leads === 0) suggestions.push('Source leads (coverage grid + source_local_businesses) or import a CSV.');

    return {
      configured,
      counts: { leads, contactsWithEmail, playbooks, activeCampaigns, bookingLinks },
      guardrails: org
        ? { dailySendCap: org.dailySendCap, quietHours: `${org.quietHoursStart}:00–${org.quietHoursEnd}:00 (lead-local)`, paused: org.paused, socialAutonomy: org.socialAutonomy }
        : null,
      suggestions,
    };
  },

  create_booking_link: async (input, ctx) => {
    const title = String(input.title || '').trim();
    if (!title) throw new Error('title is required');
    let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meet';
    if (await prisma.bookingLink.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    }
    const link = await prisma.bookingLink.create({
      data: {
        organizationId: ctx.organizationId,
        slug,
        title,
        description: input.description || null,
        durationMinutes: Math.min(Math.max(Number(input.durationMinutes) || 30, 5), 240),
        timezone: input.timezone || 'America/New_York',
        availability: {
          '1': [['09:00', '17:00']],
          '2': [['09:00', '17:00']],
          '3': [['09:00', '17:00']],
          '4': [['09:00', '17:00']],
          '5': [['09:00', '17:00']],
        },
      },
    });
    return {
      url: `${config.appPublicUrl}/book/${link.slug}`,
      title: link.title,
      durationMinutes: link.durationMinutes,
      note: 'Share this URL in outreach. The user can fine-tune availability in Settings → Booking links.',
    };
  },

  update_org_guardrails: async (input, ctx) => {
    const data: Record<string, number> = {};
    if (input.dailySendCap !== undefined) {
      data.dailySendCap = Math.min(Math.max(Number(input.dailySendCap) || 0, 1), 2000);
    }
    if (input.quietHoursStart !== undefined) {
      data.quietHoursStart = Math.min(Math.max(Number(input.quietHoursStart) || 0, 0), 23);
    }
    if (input.quietHoursEnd !== undefined) {
      data.quietHoursEnd = Math.min(Math.max(Number(input.quietHoursEnd) || 0, 0), 23);
    }
    if (Object.keys(data).length === 0) return { ok: false, note: 'Nothing to change.' };
    const org = await prisma.organization.update({
      where: { id: ctx.organizationId },
      data,
    });
    return {
      ok: true,
      guardrails: {
        dailySendCap: org.dailySendCap,
        quietHours: `${org.quietHoursStart}:00–${org.quietHoursEnd}:00 (lead-local)`,
      },
    };
  },

  update_group_summary: async (input, ctx) => {
    const group = await prisma.leadGroup.findUnique({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: input.groupName } },
    });
    if (!group) throw new Error(`No group named "${input.groupName}"`);
    await prisma.leadGroup.update({ where: { id: group.id }, data: { aiSummary: input.aiSummary } });
    return { ok: true };
  },

  create_autopilot_goal: async (input, ctx) => {
    let leadGroupId: string | undefined;
    if (input.groupName) {
      const group = await prisma.leadGroup.findUnique({
        where: {
          organizationId_name: { organizationId: ctx.organizationId, name: input.groupName },
        },
      });
      if (!group) throw new Error(`No group named "${input.groupName}" — create it first.`);
      leadGroupId = group.id;
    }
    let campaignId: string | undefined;
    if (input.campaignName) {
      const campaign = await prisma.campaign.findFirst({
        where: { organizationId: ctx.organizationId, name: input.campaignName },
      });
      if (!campaign) throw new Error(`No campaign named "${input.campaignName}".`);
      campaignId = campaign.id;
    }
    if (input.targetLeadCount && !leadGroupId) {
      throw new Error('targetLeadCount needs a linked groupName to count against.');
    }
    const targetMetric = (['LEAD_COUNT', 'ENRICHED_LEADS', 'LEADS_WITH_EMAIL'].includes(String(input.targetMetric))
      ? input.targetMetric
      : 'LEAD_COUNT') as AutopilotMetric;

    // Refuse a goal whose target is ALREADY met — it would complete on the
    // first sweep having done nothing. This is the classic mistake: pointing an
    // enrichment goal at LEAD_COUNT, which sourcing already satisfied.
    const preflight = await evaluateGoalProgress({
      leadGroupId: leadGroupId ?? null,
      targetLeadCount: input.targetLeadCount ?? null,
      targetMetric,
    });
    if (preflight?.satisfied) {
      throw new Error(
        `That goal is already complete on creation: "${input.groupName}" is at ${preflight.label}, so it would finish on the first cycle without doing any work. ` +
          (targetMetric === 'LEAD_COUNT'
            ? 'If this goal is about ENRICHING leads rather than finding more of them, set targetMetric to ENRICHED_LEADS (leads reachable enough for outreach) or LEADS_WITH_EMAIL — sourcing already satisfied the raw lead count. If it really is a sourcing goal, raise targetLeadCount above the current size.'
            : 'Raise targetLeadCount above the current value, or drop it to let the goal run until paused.')
      );
    }

    const cadenceHours = Math.min(Math.max(1, input.cadenceHours ?? 24), 24 * 30);
    const goal = await prisma.autopilotGoal.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        objective: input.objective,
        role: (input.role as AgentRole) || 'COORDINATOR',
        cadenceHours,
        leadGroupId,
        campaignId,
        targetLeadCount: input.targetLeadCount,
        targetMetric,
        createdByRunId: ctx.runId,
      },
    });
    return {
      goalId: goal.id,
      name: goal.name,
      cadenceHours,
      targetMetric,
      ...(preflight ? { startingFrom: preflight.label } : {}),
      note: `Standing goal is ACTIVE — the first cycle queues within ~5 minutes, then every ${cadenceHours}h${preflight ? ` until "${input.groupName}" reaches ${preflight.target} ${preflight.noun} (currently ${preflight.current})` : ' until paused/completed'}.`,
    };
  },

  list_autopilot_goals: async (input, ctx) => {
    const goals = await prisma.autopilotGoal.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(input.status ? { status: input.status } : {}),
      },
      include: {
        leadGroup: { select: { name: true } },
        campaign: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // Show live progress in each goal's own metric, so "why hasn't this
    // finished?" is answerable without guessing what it counts.
    const progress = await Promise.all(goals.map((g) => evaluateGoalProgress(g)));
    return {
      goals: goals.map((g, i) => ({
        goalId: g.id,
        name: g.name,
        status: g.status,
        role: g.role,
        cadenceHours: g.cadenceHours,
        group: g.leadGroup?.name,
        campaign: g.campaign?.name,
        targetLeadCount: g.targetLeadCount,
        targetMetric: g.targetMetric,
        progress: progress[i]?.label ?? null,
        nextRunAt: g.status === 'ACTIVE' ? g.nextRunAt.toISOString() : null,
        lastQueuedAt: g.lastQueuedAt?.toISOString(),
        lastResult: g.lastResult?.slice(0, 300),
        objective: g.objective.slice(0, 300),
      })),
    };
  },

  update_autopilot_goal: async (input, ctx) => {
    const goal = await prisma.autopilotGoal.findFirst({
      where: { id: input.goalId, organizationId: ctx.organizationId },
    });
    if (!goal) throw new Error('Autopilot goal not found');

    const nextMetric = (['LEAD_COUNT', 'ENRICHED_LEADS', 'LEADS_WITH_EMAIL'].includes(String(input.targetMetric))
      ? input.targetMetric
      : goal.targetMetric) as AutopilotMetric;
    const nextTarget =
      input.targetLeadCount !== undefined ? input.targetLeadCount : goal.targetLeadCount;

    // Same footgun as creation: retargeting a goal that stays ACTIVE onto an
    // already-satisfied criterion just completes it on the next sweep.
    const staysActive = (input.status ?? goal.status) === 'ACTIVE';
    const retargeting = input.targetLeadCount !== undefined || input.targetMetric !== undefined;
    if (staysActive && retargeting) {
      const preflight = await evaluateGoalProgress({
        leadGroupId: goal.leadGroupId,
        targetLeadCount: nextTarget,
        targetMetric: nextMetric,
      });
      if (preflight?.satisfied) {
        throw new Error(
          `That target is already met (${preflight.label}), so the goal would complete on the next cycle without doing any work. Raise targetLeadCount, pick a targetMetric that measures the work you actually want (ENRICHED_LEADS / LEADS_WITH_EMAIL), or set status COMPLETED explicitly if it really is done.`
        );
      }
    }

    const updated = await prisma.autopilotGoal.update({
      where: { id: goal.id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.cadenceHours
          ? { cadenceHours: Math.min(Math.max(1, input.cadenceHours), 24 * 30) }
          : {}),
        ...(input.targetLeadCount !== undefined ? { targetLeadCount: input.targetLeadCount } : {}),
        ...(input.targetMetric !== undefined ? { targetMetric: nextMetric } : {}),
        // Resuming shouldn't wait out a stale clock.
        ...(input.status === 'ACTIVE' ? { nextRunAt: new Date() } : {}),
      },
    });
    return {
      goalId: updated.id,
      status: updated.status,
      cadenceHours: updated.cadenceHours,
      targetMetric: updated.targetMetric,
    };
  },
};

/**
 * Tools that only READ — safe to execute for real inside a sandbox run.
 *
 * This is deliberately an allowlist rather than a blocklist of senders: a
 * sandbox whose promise is "nothing reaches a real person" must fail CLOSED, so
 * a tool added later is simulated by default instead of quietly sending.
 */
const SANDBOX_READ_ONLY = new Set([
  'search_web',
  'fetch_page',
  'search_leads',
  'get_lead_timeline',
  'get_enrichment_stats',
  'list_enrichment_targets',
  'list_coverage',
  'list_calendar_events',
  'get_booking_links',
  'list_playbooks',
  'list_experiments',
  'list_autopilot_goals',
  'explain_platform',
  'get_setup_status',
  'find_contacts_on_website',
  'pick_experiment_variant',
]);

/** What a simulated tool call reports back to the agent. */
function simulatedResult(name: string, input: ToolInput): Record<string, unknown> {
  const readable = name.replace(/_/g, ' ');
  return {
    simulated: true,
    note: `SANDBOX: '${readable}' was NOT executed — this is a rehearsal, so nothing was sent, called, booked or saved. Carry on exactly as you would normally, treating this step as having succeeded.`,
    wouldHaveCalled: name,
    withArguments: input,
  };
}

export async function executeTool(name: string, input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const executor = executors[name];
  if (!executor) throw new Error(`Unknown tool: ${name}`);
  if (ctx.simulate && !SANDBOX_READ_ONLY.has(name)) {
    return simulatedResult(name, input);
  }
  return executor(input, ctx);
}
