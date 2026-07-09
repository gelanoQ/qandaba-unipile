import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapRestAttendee, mapRestMessage } from "../src/backfill.js";
import type { MessageParty, Provider } from "../src/types.js";

function fixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

const attendeesPage = fixture("rest-attendees.json") as { items: unknown[] };
const attendees: MessageParty[] = attendeesPage.items.map(mapRestAttendee);
const ctx = {
  accountId: "dfXlh46vQYCsMbVarumWlg",
  provider: "linkedin" as Provider,
  attendees,
};

describe("mapRestAttendee", () => {
  it("parses the attendee field names into a MessageParty", () => {
    const philip = attendees[0]!;
    expect(philip).toEqual({
      unipileAttendeeId: "C8zaRZTlVcmfnke_Vai4Gg",
      name: "Philip Ngai",
      providerId: "ACoAAA_philip_ngai_9999",
      linkedinUrl: "https://www.linkedin.com/in/philipngai/",
    });
  });

  it("returns an all-null party for a non-object", () => {
    expect(mapRestAttendee(42)).toEqual({
      unipileAttendeeId: null,
      name: null,
      providerId: null,
      linkedinUrl: null,
    });
  });
});

describe("mapRestMessage", () => {
  it("maps an inbound REST message (is_sender=0) to a MessageEvent", () => {
    const result = mapRestMessage(fixture("rest-message-inbound.json"), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.event;
    expect(e.direction).toBe("inbound");
    expect(e.chatId).toBe("R8J-xM9WX7eoHLp6gSVtWQ");
    expect(e.messageId).toBe("ykmhfXlRW0W_cqReJYrfBw");
    // Idempotency key MUST match the webhook path's chatId:messageId so a
    // backfilled message dedupes against the same message delivered live.
    expect(e.externalId).toBe("R8J-xM9WX7eoHLp6gSVtWQ:ykmhfXlRW0W_cqReJYrfBw");
    expect(e.text).toBe("Hi Angelo, thanks for connecting!");
    expect(e.timestamp).toBe("2026-07-08T13:49:07.965Z");
    expect(e.accountId).toBe("dfXlh46vQYCsMbVarumWlg");
    expect(e.provider).toBe("linkedin");
    // Inbound: the sender is the counterparty, resolved from attendees by
    // sender_id so the profile URL is carried (contact resolution needs it).
    expect(e.sender.linkedinUrl).toBe("https://www.linkedin.com/in/philipngai/");
    expect(e.sender.providerId).toBe("ACoAAA_philip_ngai_9999");
    expect(e.attendees).toHaveLength(2);
  });

  it("maps an outbound REST message (is_sender=1) so the counterparty resolves", () => {
    const result = mapRestMessage(fixture("rest-message-outbound.json"), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.event;
    expect(e.direction).toBe("outbound");
    // Outbound: connectedUserProviderId is the sender (us). The host adapter's
    // pickCounterparty uses it to select the OTHER attendee as the counterparty.
    expect(e.connectedUserProviderId).toBe("ACoAAA_connected_user_0001");
    const counterparty = e.attendees.find(
      (a) => a.providerId !== e.connectedUserProviderId,
    );
    expect(counterparty?.linkedinUrl).toBe(
      "https://www.linkedin.com/in/philipngai/",
    );
    expect(e.externalId).toBe("R8J-xM9WX7eoHLp6gSVtWQ:outbound_msg_id_2222");
  });

  it("defaults direction to inbound when is_sender is absent", () => {
    const result = mapRestMessage(
      { id: "m1", chat_id: "c1", timestamp: "2026-07-08T00:00:00Z", text: "x" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.direction).toBe("inbound");
  });

  it("falls back to a sender party built from sender_id when not in attendees", () => {
    const result = mapRestMessage(
      {
        id: "m2",
        chat_id: "c2",
        timestamp: "2026-07-08T00:00:00Z",
        text: "hey",
        is_sender: 0,
        sender_id: "ACoAAA_stranger",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sender.providerId).toBe("ACoAAA_stranger");
    expect(result.event.sender.linkedinUrl).toBeNull();
  });

  it("rejects a message missing id / chat_id / timestamp", () => {
    const noId = mapRestMessage({ chat_id: "c", timestamp: "t" }, ctx);
    expect(noId).toEqual({ ok: false, reason: "missing_field", detail: "message_id" });
    const noChat = mapRestMessage({ id: "m", timestamp: "t" }, ctx);
    expect(noChat.ok).toBe(false);
    const notObj = mapRestMessage(null, ctx);
    expect(notObj).toEqual({ ok: false, reason: "not_an_object" });
  });

  it("treats an empty text body as an empty string, not a failure", () => {
    const result = mapRestMessage(
      { id: "m3", chat_id: "c3", timestamp: "2026-07-08T00:00:00Z", is_sender: 1, sender_id: "s" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.text).toBe("");
  });
});
