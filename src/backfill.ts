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

/** Context a REST message needs that the message object itself omits. */
export interface RestMessageContext {
  /** The connected Unipile account this history belongs to. */
  accountId: string;
  /** Provider of the chat (from the chat's account_type). */
  provider: Provider;
  /** The chat's attendees, already mapped, so senders resolve to full parties. */
  attendees: MessageParty[];
}

/**
 * Unipile sends is_sender as a boolean in docs, but REST payloads have been
 * observed to use 1/0. Treat either truthy form as "the connected user sent
 * it". Absent => not-sender => inbound (the safe default for history we are
 * ingesting on the counterparty's behalf).
 */
function isSender(value: unknown): boolean {
  return value === true || value === 1;
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
  const chatId = asString(item["chat_id"]);
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
  // OUTBOUND messages. Outbound => the connected user is the sender. Inbound =>
  // the connected user is the attendee that is NOT the sender; for a 1:1 DM
  // that is unambiguous, so resolve it when there is exactly one such attendee,
  // otherwise leave it null (the adapter does not use it for inbound anyway).
  const nonSenders = ctx.attendees.filter(
    (a) => a.providerId && a.providerId !== senderId,
  );
  const connectedUserProviderId = outbound
    ? senderId
    : nonSenders.length === 1
      ? nonSenders[0]!.providerId
      : null;

  const event: MessageEvent = {
    provider: ctx.provider,
    accountId: ctx.accountId,
    connectedUserProviderId,
    direction: outbound ? "outbound" : "inbound",
    chatId: chatId as string,
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
