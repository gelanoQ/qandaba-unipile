// normalize(): raw Unipile "new message" webhook payload -> MessageEvent.
//
// Pure and total: it never throws. Malformed or unhandled input returns
// { ok: false, reason }. The one piece of real logic is direction: the
// webhook carries no is_sender flag, so we compare the connected user's
// own provider id (account_info.user_id) against the sender's provider id
// (sender.attendee_provider_id). Equal => the connected account sent it
// (outbound); otherwise inbound. Confirmed from Unipile's docs.

import type {
  MessageEvent,
  MessageParty,
  NormalizeResult,
  Provider,
} from "./types.js";

/**
 * The event value Unipile sends for a new message. The webhook we register
 * subscribes to "on new message" only, so this is the event we expect.
 * Anything else is reported as unhandled rather than silently coerced.
 */
const NEW_MESSAGE_EVENT = "message_received";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toProvider(accountType: unknown): Provider {
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

function toParty(value: unknown): MessageParty {
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

export function normalize(payload: unknown): NormalizeResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: "not_an_object" };
  }

  const event = asString(payload["event"]);
  if (event !== NEW_MESSAGE_EVENT) {
    return {
      ok: false,
      reason: "unhandled_event",
      detail: event ?? "(missing)",
    };
  }

  const accountId = asString(payload["account_id"]);
  const chatId = asString(payload["chat_id"]);
  const messageId = asString(payload["message_id"]);
  const timestamp = asString(payload["timestamp"]);
  // Body: the webhook carries the text in `message` (REST uses `text`).
  const text = asString(payload["message"]) ?? "";

  const missing: string[] = [];
  if (!accountId) missing.push("account_id");
  if (!chatId) missing.push("chat_id");
  if (!messageId) missing.push("message_id");
  if (!timestamp) missing.push("timestamp");
  if (missing.length > 0) {
    return { ok: false, reason: "missing_field", detail: missing.join(",") };
  }

  const sender = toParty(payload["sender"]);
  const attendeesRaw = payload["attendees"];
  const attendees = Array.isArray(attendeesRaw)
    ? attendeesRaw.map(toParty)
    : [];

  const accountInfo = isRecord(payload["account_info"])
    ? payload["account_info"]
    : {};
  const connectedUserProviderId = asString(accountInfo["user_id"]);

  // Direction: no is_sender on the webhook. The connected user sent it iff
  // their own provider id equals the sender's provider id. If we cannot
  // resolve either id, default to inbound (the safe assumption for a
  // received-message webhook, and it keeps unknown senders reviewable).
  const direction =
    connectedUserProviderId !== null &&
    sender.providerId !== null &&
    connectedUserProviderId === sender.providerId
      ? "outbound"
      : "inbound";

  // accountId/chatId/messageId/timestamp are non-null here (guarded above).
  const event_: MessageEvent = {
    provider: toProvider(payload["account_type"]),
    accountId: accountId as string,
    connectedUserProviderId,
    direction,
    chatId: chatId as string,
    messageId: messageId as string,
    externalId: `${chatId}:${messageId}`,
    text,
    timestamp: timestamp as string,
    sender,
    attendees,
    raw: payload,
  };

  return { ok: true, event: event_ };
}
