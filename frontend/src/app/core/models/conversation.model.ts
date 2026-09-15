import { Contact } from './lead.model';

export type ConversationChannel = 'EMAIL' | 'SMS' | 'VOICE' | 'SOCIAL';
export type MessageDirection = 'OUTBOUND' | 'INBOUND';

export interface Message {
  campaign?: { id: string; name: string; sequenceEnabled: boolean } | null;
  experimentVariant?: { id: string; label: string; experiment: { id: string; name: string } } | null;
  provenance?: { source?: string; groupName?: string; playbookName?: string; routingPlaybookName?: string; runId?: string; groupId?: string; playbookId?: string; routingPlaybookId?: string; reason?: string; stepId?: string } | null;

  id: string;
  direction: MessageDirection;
  body: string;
  status?: string;
  externalId?: string;
  sentAt?: string;
  /** When a queued ('scheduled') message is due to go out. */
  scheduledAt?: string | null;
  createdAt: string;
}

export interface ConversationContact {
  id: string;
  firstName: string;
  lastName: string;
}

export interface Conversation {
  id: string;
  channel: ConversationChannel;
  subject?: string;
  lastMessageAt?: string;
  contact?: ConversationContact | null;
  messages: Message[];
}

export interface ConversationLeadSummary {
  group?: { id: string; name: string } | null;
  id: string;
  companyName: string;
  status: string;
}

export interface ConversationSummaryContact {
  id: string;
  name: string;
}

export interface ConversationLastMessage {
  direction: MessageDirection;
  body: string;
  status?: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  channel: ConversationChannel;
  subject?: string;
  lastMessageAt?: string;
  messageCount: number;
  lead: ConversationLeadSummary;
  contact: ConversationSummaryContact | null;
  lastMessage: ConversationLastMessage | null;
}

export interface ConversationDetail extends Conversation {
  lead: ConversationLeadSummary;
  contact: Contact | null;
}

export interface ConversationsQuery {
  replies?: 'human' | 'any';
  groupId?: string;
  channel?: string;
  search?: string;
  leadId?: string;
  page?: number;
}

export interface ConversationsPage {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  pageSize: number;
}
