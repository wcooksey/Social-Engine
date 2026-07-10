export type AgentRole = 'COORDINATOR' | 'RESEARCHER' | 'CALLER' | 'SDR';

interface RoleDefinition {
  label: string;
  persona: string;
  /** Allowed tool names, or 'all' for the generalist. */
  tools: string[] | 'all';
}

// Tools every specialist keeps: read context, take notes, move the pipeline,
// check the calendar/playbooks, and hand work to another agent via schedule_followup.
const SHARED = [
  'search_leads',
  'get_lead_timeline',
  'add_note',
  'update_lead_status',
  'list_calendar_events',
  'get_booking_links',
  'list_playbooks',
  'list_coverage',
  'update_group_summary',
  'schedule_followup',
];

export const ROLES: Record<AgentRole, RoleDefinition> = {
  COORDINATOR: {
    label: 'Coordinator',
    persona:
      'You are the Coordinator — a generalist who can do anything and orchestrate the team. Break large objectives into chunks and delegate by scheduling role-specific jobs (schedule_followup with a role): research to a Researcher, calls to a Caller, email/SMS/social outreach to an SDR. Do work directly when it is small.',
    tools: 'all',
  },
  RESEARCHER: {
    label: 'Researcher',
    persona:
      'You are a Researcher. Your job is to find and enrich leads: enumerate businesses systematically (coverage cells + source_local_businesses), search the web and social, navigate sites with the browser, identify decision makers and their contact details, and keep the CRM clean and deduplicated. When working a broad sourcing objective, ALWAYS claim cells via claim_coverage_cells and complete each one — never free-search ground the coverage plan already tracks. You do NOT send messages or make calls — when a lead is researched and ready for outreach, schedule an SDR (email/SMS/social) or Caller job to take it from here.',
    tools: [
      ...SHARED,
      'search_web',
      'fetch_page',
      'browse_web',
      'create_lead_group',
      'upsert_lead',
      'upsert_contact',
      'source_local_businesses',
      'plan_coverage',
      'claim_coverage_cells',
      'complete_coverage_cell',
    ],
  },
  CALLER: {
    label: 'Caller',
    persona:
      'You are a Caller. You place AI voice calls to leads and handle what comes of them: book demos/meetings on the calendar, update lead status from the outcome, and schedule the right follow-up. Always read the lead timeline before dialing so the call reflects history. You do not send email/SMS/social — hand those to an SDR.',
    tools: [
      ...SHARED,
      'place_call',
      'create_calendar_event',
      'update_calendar_event',
    ],
  },
  SDR: {
    label: 'SDR',
    persona:
      'You are an SDR (sales development rep) running written outreach: email, SMS, and social DMs. Personalize from the lead timeline and research notes, respect the playbooks, book meetings when leads are interested, and schedule persistent follow-ups. You do not place calls — hand those to a Caller. For research beyond a quick check, hand it to a Researcher.',
    tools: [
      ...SHARED,
      'browse_web',
      'send_email',
      'send_sms',
      'send_social_dm',
      'create_campaign',
      'add_leads_to_campaign',
      'create_calendar_event',
      'update_calendar_event',
      // Split tests: the SDR is the main autonomous sender, so it must be
      // able to allocate variants and read results (creating/concluding
      // experiments stays with the Coordinator).
      'pick_experiment_variant',
      'list_experiments',
    ],
  },
};

export function roleAllowsTool(role: AgentRole, toolName: string): boolean {
  const def = ROLES[role];
  return def.tools === 'all' || def.tools.includes(toolName);
}

export function rolePersona(role: AgentRole): string {
  return ROLES[role].persona;
}

/** Default role for a scheduled job type when the scheduler didn't specify one. */
export function defaultRoleForJobType(type: string): AgentRole {
  switch (type) {
    case 'RESEARCH':
      return 'RESEARCHER';
    case 'CAMPAIGN_STEP':
      return 'SDR';
    case 'FOLLOW_UP':
      return 'SDR';
    default:
      return 'COORDINATOR';
  }
}
