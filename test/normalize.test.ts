import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalize } from "../src/normalize.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

describe("normalize", () => {
  it("maps an inbound message from a known counterparty", () => {
    const result = normalize(fixture("inbound.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.event;
    expect(e.provider).toBe("linkedin");
    expect(e.direction).toBe("inbound");
    expect(e.chatId).toBe("R8J-xM9WX7eoHLp6gSVtWQ");
    expect(e.messageId).toBe("ykmhfXlRW0W_cqReJYrfBw");
    expect(e.externalId).toBe("R8J-xM9WX7eoHLp6gSVtWQ:ykmhfXlRW0W_cqReJYrfBw");
    expect(e.text).toBe("Hi Angelo, thanks for connecting!");
    expect(e.timestamp).toBe("2026-07-08T13:49:07.965Z");
    expect(e.sender.name).toBe("Philip Ngai");
    expect(e.sender.linkedinUrl).toBe("https://www.linkedin.com/in/philipngai/");
    expect(e.sender.providerId).toBe("ACoAAA_philip_ngai_9999");
    expect(e.connectedUserProviderId).toBe("ACoAAA_connected_user_0001");
    expect(e.attendees).toHaveLength(2);
  });

  it("derives outbound when the sender is the connected user", () => {
    const result = normalize(fixture("outbound.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.direction).toBe("outbound");
    expect(result.event.sender.providerId).toBe("ACoAAA_connected_user_0001");
  });

  it("treats an unknown sender (no id match) as inbound", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const payload = {
      ...base,
      sender: {
        attendee_id: "x",
        attendee_name: "Stranger",
        attendee_provider_id: "someone_not_in_account",
        attendee_profile_url: null,
      },
    };
    const result = normalize(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.direction).toBe("inbound");
    expect(result.event.sender.linkedinUrl).toBeNull();
  });

  it("defaults to inbound when direction cannot be resolved", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const payload = { ...base, account_info: {} };
    const result = normalize(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.direction).toBe("inbound");
    expect(result.event.connectedUserProviderId).toBeNull();
  });

  it("normalizes an empty body to an empty string, not a failure", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const { message, ...rest } = base;
    void message;
    const result = normalize(rest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.text).toBe("");
  });

  it("reads the body from `message`, ignoring a decoy `text` field", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const payload = { ...base, text: "WRONG - REST field, must be ignored" };
    const result = normalize(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.text).toBe("Hi Angelo, thanks for connecting!");
  });

  it("normalizes an explicit empty-string body to an empty string", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const result = normalize({ ...base, message: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.text).toBe("");
  });

  it("rejects a non-object payload without throwing", () => {
    for (const bad of [null, undefined, "string", 42, ["array"]]) {
      const result = normalize(bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("not_an_object");
    }
  });

  it("reports an unhandled event type", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const result = normalize({ ...base, event: "message_read" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unhandled_event");
    expect(result.detail).toBe("message_read");
  });

  it("reports a missing event as unhandled", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const { event, ...rest } = base;
    void event;
    const result = normalize(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unhandled_event");
  });

  it("reports missing required identifiers", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const { chat_id, message_id, ...rest } = base;
    void chat_id;
    void message_id;
    const result = normalize(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_field");
    expect(result.detail).toContain("chat_id");
    expect(result.detail).toContain("message_id");
  });

  it("tolerates a missing sender object", () => {
    const base = fixture("inbound.json") as Record<string, unknown>;
    const { sender, ...rest } = base;
    void sender;
    const result = normalize(rest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.sender.providerId).toBeNull();
    expect(result.event.direction).toBe("inbound");
  });
});
