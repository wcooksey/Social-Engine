import { leadService } from './lead.service';
import { timezoneForState } from '../utils/timezone';
import { prisma } from '../config/database';

/**
 * Structured lead sourcing via the Google Places API (New) Text Search.
 * Unlike a web search engine (best ~20 answers), Places is built to enumerate
 * local businesses — the backbone of "find (nearly) every dealership in
 * Florida". One text query returns up to 60 results (3 pages); systematic
 * coverage comes from running many granular queries (coverage cells).
 */

export interface PlaceResult {
  /** Google's stable id for this location — the dedup identity. */
  placeId?: string;
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

interface PlacesApiPlace {
  /** Stable per-location id, e.g. "places/ChIJ…". The identity of a rooftop. */
  id?: string;
  displayName?: { text?: string };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
}

function component(place: PlacesApiPlace, type: string, short = false): string | undefined {
  const c = place.addressComponents?.find((x) => x.types?.includes(type));
  return (short ? c?.shortText : c?.longText) || undefined;
}

export async function searchPlaces(
  query: string,
  apiKey: string,
  maxResults = 60
): Promise<{ results: PlaceResult[]; error?: string }> {
  const results: PlaceResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 3 && results.length < maxResults; page++) {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.addressComponents,nextPageToken',
      },
      body: JSON.stringify({
        textQuery: query,
        pageSize: Math.min(20, maxResults - results.length),
        ...(pageToken ? { pageToken } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { results, error: `Places API ${res.status}: ${text.slice(0, 250)}` };
    }
    const body = (await res.json()) as { places?: PlacesApiPlace[]; nextPageToken?: string };
    for (const p of body.places || []) {
      const name = p.displayName?.text?.trim();
      if (!name) continue;
      results.push({
        placeId: p.id,
        name,
        website: p.websiteUri,
        phone: p.nationalPhoneNumber,
        address: p.formattedAddress,
        city: component(p, 'locality') || component(p, 'postal_town'),
        state: component(p, 'administrative_area_level_1', true),
        postalCode: component(p, 'postal_code'),
      });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return { results };
}

export interface SourceOutcome {
  found: number;
  created: number;
  merged: number;
  error?: string;
}

/** Search Places and upsert every hit through the standard dedup path. */
export async function sourceBusinesses(
  organizationId: string,
  query: string,
  apiKey: string,
  opts: { groupId?: string; industry?: string; maxResults?: number } = {}
): Promise<SourceOutcome> {
  const { results, error } = await searchPlaces(query, apiKey, opts.maxResults ?? 60);
  let created = 0;
  let merged = 0;
  for (const r of results) {
    try {
      const { lead, created: isNew } = await leadService.upsertLead(organizationId, {
        placeId: r.placeId,
        companyName: r.name,
        website: r.website,
        phone: r.phone,
        address: r.address,
        city: r.city,
        state: r.state,
        postalCode: r.postalCode,
        industry: opts.industry,
        source: 'google_places',
        groupId: opts.groupId,
      });
      if (isNew) created++;
      else merged++;
      const tz = timezoneForState(r.state);
      if (tz && !lead.timezone) {
        await prisma.lead.update({ where: { id: lead.id }, data: { timezone: tz } });
      }
    } catch {
      // one bad row shouldn't sink the batch
    }
  }
  return { found: results.length, created, merged, ...(error ? { error } : {}) };
}
