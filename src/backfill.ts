// REST history mappers for the connect-time backfill.
//
// Live capture goes through normalize() on the webhook payload. Backfill
// instead reads history from the REST API (GET /chats/{id}/messages and
// /attendees), whose objects have a DIFFERENT shape than webhook payloads:
//   - the body field is `text` (webhook uses `message`),
//   - there is no top-level `event` or `account_info`,
//   - direction is carried explicitly as `is_sender` (webhook has neither an
//     is_sender flag nor account_info, so normalize() derives it by comparing
//     provider ids), and
//   - the sender is given as a bare `sender_id` (a provider id), not an
//     embedded party object.
//
// mapRestMessage() maps a REST message object (plus the chat's attendees, which
// carry the names and profile URLs the message object omits) to the SAME
// canonical MessageEvent that normalize() produces, so both paths persist
// through the identical host adapter. The externalId stays `chatId:messageId`,
// which is exactly the webhook key, so a backfilled message and the same
// message delivered live dedupe against each other.
//
// externalId assumption: the webhook `message_id` and the REST message `id`
// are both documented as "the unique identifier of the message for Unipile"
// (the REST object's separate `provider_id` is the native LinkedIn id, NOT used
// here). Dedup between the two paths relies on message_id === id; confirm this
// once against a real live+REST pair for the same message before trusting it in
// production (see the live smoke test in the host repo).

import type {
  MessageEvent,
  MessageParty,
  NormalizeResult,
  Provider,
} from "./types.js";
import { asString, isRecord, toParty } from "./parse.js";

/** Parse one REST chat-attendee object into a MessageParty. */
export function mapRestAttendee(value: unknown): MessageParty {
  // REST chat-attendee objects reuse the webhook attendee field names
  // (attendee_id / attendee_name / attendee_provider_id / attendee_profile_url).
  return toParty(value);
}

/**
 * Unipile flags the connected user's own attendee with is_self (1 / true).
 * Read defensively across the encodings a JSON serializer might use.
 */
function isSelf(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

/**
 * Map a page of REST chat-attendee objects to parties AND identify the
 * connected user's own provider id from the is_self flag. Resolving self from
 * is_self (authoritative, once per chat) rather than from a per-message
 * sender_id is what keeps an outbound message with a missing sender_id from
 * mis-attributing the counterparty to the account owner.
 */
export function mapRestAttendees(items: unknown[]): {
  attendees: MessageParty[];
  connectedUserProviderId: string | null;
} {
  const attendees = items.map(mapRestAttendee);
  let connectedUserProviderId: string | null = null;
  for (const raw of items) {
    if (isRecord(raw) && isSelf(raw["is_self"])) {
      connectedUserProviderId = asString(raw["attendee_provider_id"]);
      break;
    }
  }
  return { attendees, connectedUserProviderId };
}

/** Context a REST message needs that the message object itself omits. */
export interface RestMessageContext {
  /** The connected Unipile account this history belongs to. */
  accountId: string;
  /**
   * The chat id, known from the iteration URL. Message objects do not reliably
   * echo chat_id (it is a path parameter), so it is supplied here and used as a
   * fallback; without it, a message that omits chat_id would fail to map and
   * the whole chat would be silently dropped.
   */
  chatId: string;
  /** Provider of the chat (from the chat's account_type). */
  provider: Provider;
  /** The chat's attendees, already mapped, so senders resolve to full parties. */
  attendees: MessageParty[];
  /**
   * The connected user's own provider id (from mapRestAttendees). Used to pick
   * the counterparty for outbound messages independent of the per-message
   * sender_id. Optional; falls back to sender_id-based derivation when absent.
   */
  connectedUserProviderId?: string | null;
}

/**
 * Unipile sends is_sender as a boolean in docs, but REST payloads have been
 * observed to use 1/0, and a serializer could stringify it. Treat any of those
 * truthy forms as "the connected user sent it". Absent => not-sender => inbound
 * (the safe default for history we are ingesting on the counterparty's behalf).
 */
function isSender(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    (typeof value === "string" && value.toLowerCase() === "true")
  );
}

/**
 * Map a REST message object to a canonical MessageEvent. Pure and total: it
 * never throws. Malformed or field-missing input returns { ok: false }.
 */
export function mapRestMessage(
  item: unknown,
  ctx: RestMessageContext,
): NormalizeResult {
  if (!isRecord(item)) {
    return { ok: false, reason: "not_an_object" };
  }

  const messageId = asString(item["id"]);
  // chat_id may not be echoed in the message object; fall back to the chat id
  // the caller is iterating.
  const chatId = asString(item["chat_id"]) ?? ctx.chatId;
  const timestamp = asString(item["timestamp"]);
  const text = asString(item["text"]) ?? "";

  const missing: string[] = [];
  if (!messageId) missing.push("message_id");
  if (!chatId) missing.push("chat_id");
  if (!timestamp) missing.push("timestamp");
  if (missing.length > 0) {
    return { ok: false, reason: "missing_field", detail: missing.join(",") };
  }

  const outbound = isSender(item["is_sender"]);
  const senderId = asString(item["sender_id"]);

  // Resolve the sender to a full party (name + LinkedIn URL) from the chat's
  // attendees; the message object only carries the bare sender_id. If the
  // sender is not among the attendees (rare), fall back to a party built from
  // the id alone so the message is still captured (it will route to the
  // unmatched inbox for want of a profile URL).
  const senderParty: MessageParty =
    (senderId != null &&
      ctx.attendees.find((a) => a.providerId === senderId)) ||
    {
      unipileAttendeeId: null,
      name: null,
      providerId: senderId,
      linkedinUrl: null,
    };

  // connectedUserProviderId drives the host adapter's counterparty pick for
  // OUTBOUND messages. Prefer the value resolved from the attendees' is_self
  // flag (authoritative, independent of this message's sender_id). Fall back to
  // deriving it from this message: outbound => the sender is the connected
  // user; inbound => the connected user is the single non-sender attendee.
  const nonSenders = ctx.attendees.filter(
    (a) => a.providerId && a.providerId !== senderId,
  );
  const derivedConnectedId = outbound
    ? senderId
    : nonSenders.length === 1
      ? nonSenders[0]!.providerId
      : null;
  const connectedUserProviderId =
    ctx.connectedUserProviderId ?? derivedConnectedId;

  const event: MessageEvent = {
    provider: ctx.provider,
    accountId: ctx.accountId,
    connectedUserProviderId,
    direction: outbound ? "outbound" : "inbound",
    chatId,
    messageId: messageId as string,
    externalId: `${chatId}:${messageId}`,
    text,
    timestamp: timestamp as string,
    sender: senderParty,
    attendees: ctx.attendees,
    raw: item,
  };

  return { ok: true, event };
}
