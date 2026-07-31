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
  /**
   * The LinkedIn headline, the one-liner under a member's name. Present in
   * every real response we have seen and covered by the committed fixture.
   */
  headline: string | null;
  /**
   * Current employer, from the most recent work-experience entry.
   *
   * REQUIRES `sections: ["experience"]` ON THE REQUEST. Confirmed against live
   * Unipile on 2026-07-31: the field names below are correct, but a default
   * profile call returns no work-experience key at all, so this is null for
   * every profile unless the caller asked for the section.
   *
   * A null here on a member who visibly has a job means the request omitted
   * the section, not that the member has no employer.
   *
   * (The v0.5.0 comment guessed the field names were wrong. They were not, the
   * request was incomplete. Both produce an identical null, which is exactly
   * why the bug survived review of its own diff.)
   */
  company: string | null;
  /** Current job title, from the same work-experience entry as `company`. */
  title: string | null;
  /**
   * Primary email from the profile's contact info, or null.
   *
   * Returned on the DEFAULT call, no section required, but only for members
   * who share it. In a live sample of 11 real profiles, 8 carried an email and
   * every one of those was a first-degree connection. Absence is normal and is
   * never evidence that the request was built wrong.
   */
  email: string | null;
  /** Primary phone from the same contact info, or null. Same caveats. */
  phone: string | null;
}

/**
 * First usable string in what should be an array of them.
 *
 * Every layer is defensive on purpose: `contact_info` is absent on most
 * profiles, and when present its arrays are populated by whatever the member
 * typed. A non-array, an empty array, a null element or a blank string all mean
 * the same thing to a caller (nothing to prefill), so they all collapse to null
 * rather than reaching a form as `undefined` or `""`.
 *
 * The value is returned TRIMMED. Live LinkedIn data really does carry padding
 * ("Minneapolis ", "QSS Technosoft Inc. "), and a padded email is not cosmetic
 * downstream: the host keys contact identity off the email, so " a@b.com " and
 * "a@b.com" resolve to two contacts that never match each other.
 */
function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const str = asString(entry)?.trim();
    if (str) return str;
  }
  return null;
}

/**
 * Pull the primary email and phone out of a profile's contact info.
 *
 * LinkedIn returns this on the default profile call for members who share it,
 * so unlike work experience it costs nothing extra. v0.5.0 read the response
 * and discarded this object entirely.
 */
function contactInfo(raw: Record<string, unknown>): {
  email: string | null;
  phone: string | null;
} {
  const info = raw["contact_info"];
  if (!isRecord(info)) return { email: null, phone: null };
  return {
    email: firstString(info["emails"]),
    phone: firstString(info["phones"]),
  };
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
 * Pull the current employer and title out of a profile's work history.
 *
 * Takes the FIRST entry: Unipile returns work experience most-recent-first, and
 * an entry with no end date is the current one. Preferring an open-ended entry
 * when one exists guards the case where the ordering is not what we assume, so
 * a member with a past role listed first does not get their old job reported as
 * current. A profile with no work history yields nulls rather than throwing;
 * enrichment degrading to a blank field is always better than aborting.
 */
function currentPosition(raw: Record<string, unknown>): {
  company: string | null;
  title: string | null;
} {
  const history = raw["work_experience"];
  if (!Array.isArray(history) || history.length === 0) {
    return { company: null, title: null };
  }
  const entries = history.filter(isRecord);
  if (entries.length === 0) return { company: null, title: null };
  const open = entries.find((e) => !asString(e["end"]) && !asString(e["end_date"]));
  const entry = open ?? entries[0];
  if (!entry) return { company: null, title: null };
  return {
    company: asString(entry["company"]),
    title: asString(entry["position"]) ?? asString(entry["title"]),
  };
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
      headline: null,
      company: null,
      title: null,
      email: null,
      phone: null,
    };
  }
  const publicIdentifier = asString(value["public_identifier"]);
  const current = currentPosition(value);
  const contact = contactInfo(value);
  return {
    providerId: asString(value["provider_id"]),
    publicIdentifier,
    linkedinUrl: vanityUrl(publicIdentifier),
    name: composeName(value),
    headline: asString(value["headline"]),
    company: current.company,
    title: current.title,
    email: contact.email,
    phone: contact.phone,
  };
}
