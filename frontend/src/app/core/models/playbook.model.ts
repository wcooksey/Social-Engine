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
}
