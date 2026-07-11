/**
 * Availability is keyed by ISO weekday "1".."7" (1 = Monday), each value an
 * array of ["HH:MM","HH:MM"] windows, e.g. { "1": [["09:00", "17:00"]] }.
 */
export type Availability = Record<string, [string, string][]>;

export interface BookingLink {
  id: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  timezone: string;
  availability: Availability;
  active: boolean;
  /** Full public link a prospect can open (e.g. https://app.example.com/book/my-slug). */
  url: string;
}

export interface BookingLinkInput {
  title: string;
  description?: string;
  durationMinutes?: number;
  bufferMinutes?: number;
  timezone?: string;
  availability?: Availability;
}
