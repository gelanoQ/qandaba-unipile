// Canonical, host-agnostic types for the Unipile integration.
//
// These are the integration seam. A host application (qandaba-os,
// bcs-lead-engine) implements HostAdapter to persist a MessageEvent into
// its own schema. Nothing here knows about any database or framework.

/** Whether the connected account sent the message or received it. */
export type MessageDirection = "inbound" | "outbound";

/**
 * Unipile provider label, normalized to lowercase. Unipile sends these
 * uppercase (LINKEDIN, WHATSAPP, ...); we lowercase them. LinkedIn is the
 * only provider this package is exercised against today, but the type is
 * open so the same normalizer can grow to other channels.
 */
export type Provider =
  | "linkedin"
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "messenger"
  | "x"
  | "unknown";

/** The other party on a message: who sent it (for inbound) or the target. */
export interface MessageParty {
  /** Unipile's per-conversation attendee id. */
  unipileAttendeeId: string | null;
  /** Display name as Unipile resolved it. */
  name: string | null;
  /** Provider-specific id (for LinkedIn, the member's provider id). */
  providerId: string | null;
  /** Public profile URL when the provider exposes one (LinkedIn). */
  linkedinUrl: string | null;
}

/**
 * A single normalized message. This is what host adapters persist. It is
 * deliberately flat and provider-neutral. `externalId` is the idempotency
 * key a host should use to dedupe (`chatId:messageId`).
 */
export interface MessageEvent {
  provider: Provider;
  /** The Unipile account (the connected user's account) that saw this message. */
  accountId: string;
  /** The connected user's own provider id, used to derive direction. */
  connectedUserProviderId: string | null;
  direction: MessageDirection;
  /** Unipile conversation id. */
  chatId: string;
  /** Unipile message id. */
  messageId: string;
  /** `chatId:messageId`. Stable idempotency key across retries and echoes. */
  externalId: string;
  /** Plain-text body. */
  text: string;
  /** ISO 8601 timestamp of the message. */
  timestamp: string;
  /** The counterparty (message sender). */
  sender: MessageParty;
  /** All attendees on the conversation, sender included. */
  attendees: MessageParty[];
  /** The untouched original payload, for debugging and forward-compat. */
  raw: unknown;
}

/**
 * The seam each host implements. Given a normalized MessageEvent, persist
 * it however the host's schema requires (in qandaba-os: resolve the
 * contact and insert a proposed touch). Idempotency is the host's
 * responsibility, keyed on MessageEvent.externalId.
 */
export interface HostAdapter {
  persistMessage(event: MessageEvent): Promise<void>;
}

/**
 * Result of normalize(). normalize never throws; malformed or unhandled
 * input returns { ok: false } with a machine-readable reason so callers
 * can log and drop without a try/catch.
 */
export type NormalizeResult =
  | { ok: true; event: MessageEvent }
  | { ok: false; reason: NormalizeFailureReason; detail?: string };

export type NormalizeFailureReason =
  | "not_an_object"
  | "unhandled_event"
  | "missing_field";
