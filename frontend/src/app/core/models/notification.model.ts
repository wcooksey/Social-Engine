/**
 * In-app notification shown in the header bell. Named `AppNotification` to avoid
 * clashing with the built-in DOM `Notification` type.
 */
export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body?: string;
  leadId?: string;
  read: boolean;
  createdAt: string;
}

/** Payload returned by `GET /api/notifications`. */
export interface NotificationsResponse {
  notifications: AppNotification[];
  unread: number;
}

/** Payload returned by `POST /api/notifications/read`. */
export interface MarkReadResponse {
  marked: number;
  unread: number;
}
