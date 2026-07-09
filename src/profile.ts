// Profile-retrieval mapper for contact enrichment.
//
// The Unipile attendee payload only ever gives us a LinkedIn `provider_id`
// (an opaque `ACoAA...` id, which is also the slug of the profile_url it
// returns). A host that stores contacts by their human VANITY URL
// (linkedin.com/in/johndoe) cannot match a provider-id URL by equality.
//
// GET /api/v1/users/{identifier}?account_id=... ("Retrieve a profile")
// resolves a provider_id to the member's `public_identifier` (the vanity
// slug), which IS what a stored vanity URL is keyed on. mapUserProfile()
// turns that raw response into the small shape a host needs to match: the
// vanity slug and a canonical vanity URL built from it, plus the provider_id
// so the host can store it for a subsequent no-API lookup.

import { asString, isRecord } from "./parse.js";

export interface UserProfile {
  /** LinkedIn's opaque member id (the `ACoAA...` value). */
  providerId: string | null;
  /** The vanity slug, e.g. "johndoe" for linkedin.com/in/johndoe. */
  publicIdentifier: string | null;
  /**
   * Canonical vanity profile URL built from publicIdentifier, or null when the
   * profile has no public identifier. This is the value a host matches against
   * a contact's stored vanity linkedin_url.
   */
  linkedinUrl: string | null;
  /** Display name if the response carries one (best-effort). */
  name: string | null;
}

/** Build a canonical LinkedIn vanity URL from a public identifier. */
function vanityUrl(publicIdentifier: string | null): string | null {
  if (!publicIdentifier) return null;
  return `https://www.linkedin.com/in/${publicIdentifier}`;
}

/** Compose a display name from first/last when a whole name is not present. */
function composeName(raw: Record<string, unknown>): string | null {
  const whole = asString(raw["name"]);
  if (whole) return whole;
  const first = asString(raw["first_name"]);
  const last = asString(raw["last_name"]);
  const joined = [first, last].filter((v) => v && v.trim().length > 0).join(" ");
  return joined.length > 0 ? joined : null;
}

/**
 * Map a raw Unipile "Retrieve a profile" response to a UserProfile. Missing or
 * malformed input yields an all-null profile rather than throwing, so an
 * enrichment miss degrades to "leave the message unmatched" instead of aborting
 * a backfill.
 */
export function mapUserProfile(value: unknown): UserProfile {
  if (!isRecord(value)) {
    return {
      providerId: null,
      publicIdentifier: null,
      linkedinUrl: null,
      name: null,
    };
  }
  const publicIdentifier = asString(value["public_identifier"]);
  return {
    providerId: asString(value["provider_id"]),
    publicIdentifier,
    linkedinUrl: vanityUrl(publicIdentifier),
    name: composeName(value),
  };
}
