// Shared parsing primitives used by both the webhook normalizer and the
// REST backfill mapper. Unipile reuses the same attendee field names
// (attendee_id / attendee_name / attendee_provider_id / attendee_profile_url)
// on webhook payloads and REST chat-attendee objects, so the party parser is
// identical for both paths and lives here rather than being duplicated.

import type { MessageParty, Provider } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Map a Unipile provider label (any case) to our lowercase Provider union. */
export function toProvider(accountType: unknown): Provider {
  if (typeof accountType !== "string") return "unknown";
  switch (accountType.toUpperCase()) {
    case "LINKEDIN":
      return "linkedin";
    case "WHATSAPP":
      return "whatsapp";
    case "INSTAGRAM":
      return "instagram";
    case "TELEGRAM":
      return "telegram";
    case "MESSENGER":
      return "messenger";
    case "X":
    case "TWITTER":
      return "x";
    default:
      return "unknown";
  }
}

/**
 * Parse an attendee/sender object (webhook `sender`/`attendees[]` items and
 * REST chat-attendee objects share these field names). Missing or non-object
 * input yields an all-null party rather than throwing.
 */
export function toParty(value: unknown): MessageParty {
  if (!isRecord(value)) {
    return {
      unipileAttendeeId: null,
      name: null,
      providerId: null,
      linkedinUrl: null,
    };
  }
  return {
    unipileAttendeeId: asString(value["attendee_id"]),
    name: asString(value["attendee_name"]),
    providerId: asString(value["attendee_provider_id"]),
    linkedinUrl: asString(value["attendee_profile_url"]),
  };
}
