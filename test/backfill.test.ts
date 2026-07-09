import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mapRestAttendee,
  mapRestAttendees,
  mapRestMessage,
} from "../src/backfill.js";
import type { Provider } from "../src/types.js";

function fixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

const attendeesPage = fixture("rest-attendees.json") as { items: unknown[] };
const { attendees, connectedUserProviderId } = mapRestAttendees(
  attendeesPage.items,
);
const ctx = {
  accountId: "dfXlh46vQYCsMbVarumWlg",
  chatId: "R8J-xM9WX7eoHLp6gSVtWQ",
  provider: "linkedin" as Provider,
  attendees,
  connectedUserProviderId,
};

describe("mapRestAttendee / mapRestAttendees", () => {
  it("parses the attendee field names into a MessageParty", () => {
    expect(attendees[0]).toEqual({
      unipileAttendeeId: "C8zaRZTlVcmfnke_Vai4Gg",
      name: "Philip Ngai",
      providerId: "ACoAAA_philip_ngai_9999",
      linkedinUrl: "https://www.linkedin.com/in/philipngai/",
    });
  });

  it("reads the UNPREFIXED REST fields (id/name/provider_id/profile_url), not attendee_*", () => {
    // Regression: the REST ChatAttendee object uses unprefixed field names. The
    // original mapper read attendee_* (the webhook shape), so every REST
    // attendee parsed to all-null and messages showed the bare provider id
    // instead of the person's name.
    const p = mapRestAttendee({
      id: "att-1",
      name: "Mohammad Alim",
      provider_id: "ACoAAADWdH8B_x",
      profile_url: "https://www.linkedin.com/in/ACoAAADWdH8B_x",
      is_self: 0,
    });
    expect(p).toEqual({
      unipileAttendeeId: "att-1",
      name: "Mohammad Alim",
      providerId: "ACoAAADWdH8B_x",
      linkedinUrl: "https://www.linkedin.com/in/ACoAAADWdH8B_x",
    });
  });

  it("identifies the connected user from the is_self attendee flag", () => {
    expect(connectedUserProviderId).toBe("ACoAAA_connected_user_0001");
  });

  it("returns null connected user when no attendee is flagged is_self", () => {
    const r = mapRestAttendees([
      { attendee_provider_id: "a" },
      { attendee_provider_id: "b" },
    ]);
    expect(r.connectedUserProviderId).toBeNull();
    expect(r.attendees).toHaveLength(2);
  });

  it("returns an all-null party for a non-object attendee", () => {
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
    // connectedUserProviderId comes from the is_self attendee, so the host
    // adapter's pickCounterparty selects the OTHER attendee as the counterparty.
    expect(e.connectedUserProviderId).toBe("ACoAAA_connected_user_0001");
    const counterparty = e.attendees.find(
      (a) => a.providerId !== e.connectedUserProviderId,
    );
    expect(counterparty?.linkedinUrl).toBe(
      "https://www.linkedin.com/in/philipngai/",
    );
    expect(e.externalId).toBe("R8J-xM9WX7eoHLp6gSVtWQ:outbound_msg_id_2222");
  });

  it("falls back to ctx.chatId when the message object omits chat_id", () => {
    const result = mapRestMessage(
      { id: "m-nochat", timestamp: "2026-07-08T00:00:00Z", text: "x", is_sender: 0, sender_id: "ACoAAA_philip_ngai_9999" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.chatId).toBe("R8J-xM9WX7eoHLp6gSVtWQ");
    expect(result.event.externalId).toBe("R8J-xM9WX7eoHLp6gSVtWQ:m-nochat");
  });

  it("treats a stringified is_sender ('1'/'true') as outbound", () => {
    for (const flag of ["1", "true", "True"]) {
      const r = mapRestMessage(
        { id: `m-${flag}`, chat_id: "c", timestamp: "t2026", is_sender: flag, sender_id: "ACoAAA_connected_user_0001" },
        ctx,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.event.direction).toBe("outbound");
    }
  });

  it("defaults direction to inbound when is_sender is absent", () => {
    const result = mapRestMessage(
      { id: "m1", chat_id: "c1", timestamp: "2026-07-08T00:00:00Z", text: "x" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.direction).toBe("inbound");
  });

  it("uses ctx.connectedUserProviderId for outbound even when sender_id is missing", () => {
    // Outbound with no sender_id: without the is_self-derived connected id, the
    // counterparty pick would fall to the first attendee (possibly self).
    const result = mapRestMessage(
      { id: "m-nosender", chat_id: "c", timestamp: "t", is_sender: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.connectedUserProviderId).toBe(
      "ACoAAA_connected_user_0001",
    );
    const counterparty = result.event.attendees.find(
      (a) => a.providerId !== result.event.connectedUserProviderId,
    );
    expect(counterparty?.providerId).toBe("ACoAAA_philip_ngai_9999");
  });

  it("resolves an inbound 1:1 counterparty via the lone non-self attendee when sender_id does not match", () => {
    // sender_id disagrees with provider_id (or is a different id variant): on a
    // 1:1 DM the counterparty is unambiguous, so the name + URL still come
    // through rather than degrading to a bare id.
    const result = mapRestMessage(
      {
        id: "m2",
        chat_id: "c2",
        timestamp: "2026-07-08T00:00:00Z",
        text: "hey",
        is_sender: 0,
        sender_id: "ACoAAA_mismatch",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sender.name).toBe("Philip Ngai");
    expect(result.event.sender.linkedinUrl).toBe(
      "https://www.linkedin.com/in/philipngai/",
    );
  });

  it("falls back to an id-only sender when it cannot disambiguate (group chat, no match)", () => {
    // Two non-self attendees and an unmatched sender_id: we cannot tell who sent
    // it, so build an id-only party (routes to the unmatched inbox).
    const groupCtx = {
      ...ctx,
      attendees: [
        ...ctx.attendees,
        {
          unipileAttendeeId: "att-3",
          name: "Dana",
          providerId: "ACoAAA_dana",
          linkedinUrl: "https://www.linkedin.com/in/dana/",
        },
      ],
    };
    const result = mapRestMessage(
      { id: "m3", chat_id: "c3", timestamp: "t", is_sender: 0, sender_id: "ACoAAA_stranger" },
      groupCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sender.providerId).toBe("ACoAAA_stranger");
    expect(result.event.sender.linkedinUrl).toBeNull();
  });

  it("rejects a message missing id or timestamp, or a non-object", () => {
    const noId = mapRestMessage({ chat_id: "c", timestamp: "t" }, ctx);
    expect(noId).toEqual({ ok: false, reason: "missing_field", detail: "message_id" });
    const noTs = mapRestMessage({ id: "m", chat_id: "c" }, ctx);
    expect(noTs).toEqual({ ok: false, reason: "missing_field", detail: "timestamp" });
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
