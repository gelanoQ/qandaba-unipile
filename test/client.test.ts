import { describe, it, expect } from "vitest";
import {
  UnipileClient,
  UnipileApiError,
  type FetchLike,
} from "../src/client.js";

interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
}

/** Assert a recorded body is JSON text and parse it. */
function jsonBody(call: RecordedCall): unknown {
  if (typeof call.body !== "string") {
    throw new Error(`expected a JSON string body, got ${typeof call.body}`);
  }
  return JSON.parse(call.body);
}

/** Assert a recorded body is multipart form data and return it. */
function formBody(call: RecordedCall): FormData {
  if (!(call.body instanceof FormData)) {
    throw new Error(`expected a FormData body, got ${typeof call.body}`);
  }
  return call.body;
}

/** A fetch stub that records calls and returns queued responses. */
function stubFetch(
  responses: Array<{ ok?: boolean; status?: number; body?: unknown }>,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = responses[i] ?? { ok: true, status: 200, body: {} };
    i += 1;
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return {
      ok: r.ok ?? status < 400,
      status,
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, dsn = "api8.unipile.com:13443") {
  return new UnipileClient({ dsn, apiKey: "KEY123", fetch });
}

describe("UnipileClient construction", () => {
  it("requires dsn and apiKey", () => {
    const { fetch } = stubFetch([]);
    expect(() => new UnipileClient({ dsn: "", apiKey: "k", fetch })).toThrow();
    expect(() => new UnipileClient({ dsn: "d", apiKey: "", fetch })).toThrow();
  });

  it("prefixes https when the dsn has no scheme and keeps one that does", async () => {
    const bare = stubFetch([{ body: { items: [], cursor: null } }]);
    await client(bare.fetch, "api8.unipile.com:13443").listChats({
      accountId: "a",
    });
    expect(bare.calls[0]!.url).toMatch(
      /^https:\/\/api8\.unipile\.com:13443\/api\/v1\/chats\?/,
    );

    const full = stubFetch([{ body: { items: [], cursor: null } }]);
    await client(full.fetch, "https://api8.unipile.com/").listChats({
      accountId: "a",
    });
    expect(full.calls[0]!.url).toMatch(
      /^https:\/\/api8\.unipile\.com\/api\/v1\/chats\?/,
    );
  });
});

describe("auth + send", () => {
  it("sends the X-API-KEY header on every request", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).sendMessage({ chatId: "c1", text: "hi" });
    expect(calls[0]!.headers?.["X-API-KEY"]).toBe("KEY123");
    expect(calls[0]!.headers?.["accept"]).toBe("application/json");
  });

  // Unipile's two send endpoints take file fields (attachments, voice_message,
  // video_message), so they are multipart/form-data ONLY; a JSON body is
  // rejected and the send never leaves. An earlier version of these tests
  // asserted application/json, which pinned our guess instead of Unipile's
  // contract and kept the send path broken in production for every send.
  // See qandaba-os#622.
  it("posts a reply to /chats/{chatId}/messages as multipart, not JSON", async () => {
    const { fetch, calls } = stubFetch([{ body: { id: "m1" } }]);
    await client(fetch).sendMessage({
      chatId: "c1",
      text: "hello",
      accountId: "acc1",
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      "https://api8.unipile.com:13443/api/v1/chats/c1/messages",
    );
    const form = formBody(call);
    expect(form.get("text")).toBe("hello");
    expect(form.get("account_id")).toBe("acc1");
  });

  // The multipart content-type carries a generated boundary, so the runtime
  // must set the header itself. Setting it by hand produces a header with no
  // boundary and the request fails to parse server-side.
  it("leaves content-type unset on a multipart send so fetch adds the boundary", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).sendMessage({ chatId: "c1", text: "hi" });
    const headers = calls[0]!.headers ?? {};
    const contentTypeKeys = Object.keys(headers).filter(
      (k) => k.toLowerCase() === "content-type",
    );
    expect(contentTypeKeys).toEqual([]);
  });

  it("omits account_id from the form when not provided", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).sendMessage({ chatId: "c1", text: "hi" });
    const form = formBody(calls[0]!);
    expect(form.get("text")).toBe("hi");
    expect(form.has("account_id")).toBe(false);
  });

  it("url-encodes the chat id in the path", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).sendMessage({ chatId: "a/b c", text: "x" });
    expect(calls[0]!.url).toContain("/chats/a%2Fb%20c/messages");
  });

  // attendees_ids is an array, encoded as a repeated field. NOTE: unlike the
  // reply path, this cold-start encoding is NOT confirmed by a live call,
  // because confirming it means opening a chat with a real stranger. Treat it
  // as the documented-but-unverified half until a safe live check exists.
  it("starts a new chat as multipart with repeated attendees_ids", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).startChat({
      accountId: "acc1",
      attendeesIds: ["p1", "p2"],
      text: "hey",
    });
    expect(calls[0]!.url).toBe("https://api8.unipile.com:13443/api/v1/chats");
    const form = formBody(calls[0]!);
    expect(form.get("account_id")).toBe("acc1");
    expect(form.getAll("attendees_ids")).toEqual(["p1", "p2"]);
    expect(form.get("text")).toBe("hey");
  });

  it("omits text from the new-chat form when not provided", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).startChat({ accountId: "acc1", attendeesIds: ["p1"] });
    expect(formBody(calls[0]!).has("text")).toBe(false);
  });

  // Only the two send endpoints are multipart. Everything else stays JSON, so
  // the multipart fix must not leak across the whole client.
  it("creates a hosted auth link as JSON, passing the body through", async () => {
    const { fetch, calls } = stubFetch([{ body: { url: "https://..." } }]);
    await client(fetch).createHostedAuthLink({ providers: ["LINKEDIN"] });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://api8.unipile.com:13443/api/v1/hosted/accounts/link",
    );
    expect(calls[0]!.headers?.["content-type"]).toBe("application/json");
    expect(jsonBody(calls[0]!)).toEqual({ providers: ["LINKEDIN"] });
  });
});

describe("list + pagination", () => {
  it("lists chats with query params and uppercased account_type", async () => {
    const { fetch, calls } = stubFetch([{ body: { items: [], cursor: null } }]);
    await client(fetch).listChats({
      accountId: "acc1",
      accountType: "linkedin",
      limit: 50,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/chats");
    expect(url.searchParams.get("account_id")).toBe("acc1");
    expect(url.searchParams.get("account_type")).toBe("LINKEDIN");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("iterates messages across pages until the cursor is null", async () => {
    const { fetch, calls } = stubFetch([
      { body: { items: [{ id: "a" }, { id: "b" }], cursor: "c2" } },
      { body: { items: [{ id: "c" }], cursor: null } },
    ]);
    const seen: unknown[] = [];
    for await (const m of client(fetch).iterateMessages({ chatId: "chat1" })) {
      seen.push(m);
    }
    expect(seen).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(calls).toHaveLength(2);
    // Second page must carry the cursor from the first response.
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
  });

  it("yields nothing (no throw) when a 200 comes back with an empty body", async () => {
    const { fetch } = stubFetch([{ ok: true, status: 200, body: undefined }]);
    const seen: unknown[] = [];
    for await (const m of client(fetch).iterateMessages({ chatId: "c" })) {
      seen.push(m);
    }
    expect(seen).toEqual([]);
  });

  it("iterates chats across pages, threading the cursor", async () => {
    const { fetch, calls } = stubFetch([
      { body: { items: [{ id: "chat1" }], cursor: "next" } },
      { body: { items: [{ id: "chat2" }, { id: "chat3" }], cursor: null } },
    ]);
    const seen: unknown[] = [];
    for await (const c of client(fetch).iterateChats({ accountId: "acc1" })) {
      seen.push(c);
    }
    expect(seen).toEqual([{ id: "chat1" }, { id: "chat2" }, { id: "chat3" }]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("account_id")).toBe("acc1");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("next");
  });

  it("lists a page of chat attendees at /chats/{id}/attendees", async () => {
    const { fetch, calls } = stubFetch([
      { body: { items: [{ attendee_id: "a1" }], cursor: null } },
    ]);
    const page = await client(fetch).listChatAttendees({ chatId: "c/1" });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "https://api8.unipile.com:13443/api/v1/chats/c%2F1/attendees",
    );
    expect(page.items).toEqual([{ attendee_id: "a1" }]);
  });

  it("iterates chat attendees across pages", async () => {
    const { fetch, calls } = stubFetch([
      { body: { items: [{ attendee_id: "a1" }], cursor: "p2" } },
      { body: { items: [{ attendee_id: "a2" }], cursor: null } },
    ]);
    const seen: unknown[] = [];
    for await (const a of client(fetch).iterateChatAttendees({ chatId: "c1" })) {
      seen.push(a);
    }
    expect(seen).toEqual([{ attendee_id: "a1" }, { attendee_id: "a2" }]);
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("p2");
  });

  it("stops instead of looping forever when a cursor never advances", async () => {
    // A misbehaving endpoint echoing the same non-null cursor: the guard must
    // break, not fetch endlessly.
    const { fetch, calls } = stubFetch([
      { body: { items: [{ id: "a" }], cursor: "stuck" } },
      { body: { items: [{ id: "b" }], cursor: "stuck" } },
      { body: { items: [{ id: "c" }], cursor: "stuck" } },
    ]);
    const seen: unknown[] = [];
    for await (const m of client(fetch).iterateMessages({ chatId: "c1" })) {
      seen.push(m);
    }
    // Two fetches: page 1 (cursor undefined -> "stuck"), page 2 (cursor "stuck"
    // -> "stuck" again == previous request cursor -> stop).
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("defaults a bodyless list response to an empty page", async () => {
    const { fetch } = stubFetch([{ ok: true, status: 200, body: undefined }]);
    const page = await client(fetch).listChats({ accountId: "a" });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeNull();
  });
});

describe("webhooks", () => {
  it("creates a messaging webhook with the auth header and request_url", async () => {
    const { fetch, calls } = stubFetch([{ body: { webhook_id: "wh1" } }]);
    await client(fetch).createWebhook({
      requestUrl: "https://os.qandaba.com/api/integrations/unipile/webhook",
      authHeaderValue: "SECRET",
      name: "qandaba-os-messaging",
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api8.unipile.com:13443/api/v1/webhooks");
    expect(call.headers?.["X-API-KEY"]).toBe("KEY123");
    expect(jsonBody(call)).toEqual({
      source: "messaging",
      request_url:
        "https://os.qandaba.com/api/integrations/unipile/webhook",
      name: "qandaba-os-messaging",
      headers: [{ key: "X-Unipile-Auth", value: "SECRET" }],
    });
  });

  it("lets the caller override source and the auth header name", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).createWebhook({
      requestUrl: "https://x/y",
      source: "account_status",
      authHeaderName: "X-Custom",
      authHeaderValue: "S",
    });
    expect(jsonBody(calls[0]!)).toEqual({
      source: "account_status",
      request_url: "https://x/y",
      headers: [{ key: "X-Custom", value: "S" }],
    });
  });

  it("lists webhooks and coerces a bodyless response to an empty list", async () => {
    const listed = stubFetch([
      { body: { items: [{ id: "wh1" }], cursor: null } },
    ]);
    const page = await client(listed.fetch).listWebhooks();
    expect(listed.calls[0]!.method).toBe("GET");
    expect(listed.calls[0]!.url).toBe(
      "https://api8.unipile.com:13443/api/v1/webhooks",
    );
    expect(page.items).toEqual([{ id: "wh1" }]);

    const empty = stubFetch([{ ok: true, status: 200, body: undefined }]);
    const emptyPage = await client(empty.fetch).listWebhooks();
    expect(emptyPage.items).toEqual([]);
  });

  it("deletes a webhook by id, url-encoding the id", async () => {
    const { fetch, calls } = stubFetch([{ body: {} }]);
    await client(fetch).deleteWebhook("wh/1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api8.unipile.com:13443/api/v1/webhooks/wh%2F1",
    );
  });
});

describe("errors", () => {
  it("throws UnipileApiError with the status on a non-2xx response", async () => {
    const { fetch } = stubFetch([{ ok: false, status: 401, body: { error: "bad key" } }]);
    await expect(
      client(fetch).listChats({ accountId: "a" }),
    ).rejects.toBeInstanceOf(UnipileApiError);
  });

  it("exposes the status code on the thrown error", async () => {
    const { fetch } = stubFetch([{ ok: false, status: 429, body: "rate" }]);
    try {
      await client(fetch).sendMessage({ chatId: "c", text: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnipileApiError);
      expect((err as UnipileApiError).status).toBe(429);
    }
  });

  it("carries the response body on the thrown error", async () => {
    const { fetch } = stubFetch([
      { ok: false, status: 400, body: { error: "chat not owned" } },
    ]);
    try {
      await client(fetch).sendMessage({ chatId: "c", text: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as UnipileApiError).body).toContain("chat not owned");
    }
  });
});
