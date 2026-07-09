import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Conversation, ConversationDetail, ConversationsPage, ConversationsQuery } from '../models/conversation.model';

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
}
