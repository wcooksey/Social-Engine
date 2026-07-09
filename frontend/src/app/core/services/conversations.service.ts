import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Conversation, ConversationDetail, ConversationsPage, ConversationsQuery, Message } from '../models/conversation.model';

@Injectable({ providedIn: 'root' })
export class ConversationsService {
  private api = inject(ApiService);

  listInbox(query: ConversationsQuery = {}): Observable<ConversationsPage> {
    return this.api.get<ConversationsPage>('/api/conversations', query);
  }

  getConversation(id: string): Observable<ConversationDetail> {
    return this.api.get<ConversationDetail>(`/api/conversations/${id}`);
  }

  getLeadConversations(leadId: string): Observable<Conversation[]> {
    return this.api.get<Conversation[]>(`/api/leads/${leadId}/conversations`);
  }

  /** Send a manual reply on an EMAIL or SMS conversation. */
  sendMessage(conversationId: string, body: string, subject?: string): Observable<Message> {
    const payload: { body: string; subject?: string } = { body };
    if (subject) payload.subject = subject;
    return this.api.post<Message>(`/api/conversations/${conversationId}/messages`, payload);
  }

  /** Approve a draft message and send it, optionally with an edited body. */
  approveDraft(conversationId: string, messageId: string, body?: string): Observable<Message> {
    const payload: { body?: string } = {};
    if (body !== undefined) payload.body = body;
    return this.api.post<Message>(`/api/conversations/${conversationId}/messages/${messageId}/send`, payload);
  }

  /** Discard a draft message (drafts only). */
  discardDraft(conversationId: string, messageId: string): Observable<unknown> {
    return this.api.delete<unknown>(`/api/conversations/${conversationId}/messages/${messageId}`);
  }
}
