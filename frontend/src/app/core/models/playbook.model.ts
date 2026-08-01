export type PlaybookScope = 'GLOBAL' | 'GROUP' | 'CAMPAIGN' | 'LEAD_STATUS';
export type PlaybookChannel = 'ALL' | 'EMAIL' | 'SMS' | 'VOICE';

export interface Playbook {
  id: string;
  name: string;
  scope: PlaybookScope;
  groupId?: string | null;
  group?: { id: string; name: string } | null;
  campaignId?: string | null;
  campaign?: { id: string; name: string } | null;
  leadStatus?: string | null;
  channel: PlaybookChannel;
  instructions: string;
  isActive: boolean;
  priority: number;
  createdAt: string;
  /** Engine conversations filed under this playbook. */
  _count?: { engineChats: number };

  // Sender identity — who outreach under this playbook presents as. All
  // optional; blank falls back to the organization.
  identityName?: string | null;
  identityOrgName?: string | null;
  identityTitle?: string | null;
  identityEmail?: string | null;
  identitySignature?: string | null;
}

/** True when a playbook overrides any part of the sender identity. */
export function hasIdentity(playbook: Playbook): boolean {
  return !!(
    playbook.identityName ||
    playbook.identityOrgName ||
    playbook.identityTitle ||
    playbook.identityEmail ||
    playbook.identitySignature
  );
}
