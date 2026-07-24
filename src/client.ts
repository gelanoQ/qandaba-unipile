// UnipileClient: a thin, dependency-free wrapper over the Unipile REST API.
//
// We deliberately do not depend on Unipile's Node SDK: this package is a
// shared git dependency and stays lighter and fully offline-testable with
// an injectable fetch. Only the endpoints this integration needs are
// wrapped. Auth is the `X-API-KEY` header (not Authorization). Base URL is
// `https://{dsn}/api/v1`.
//
// Endpoints confirmed from developer.unipile.com:
//   POST /chats/{chat_id}/messages   reply into an existing chat
//   POST /chats                      start a new chat (attendees_ids)
//   GET  /chats                      list chats (cursor pagination)
//   GET  /chats/{chat_id}/messages   list messages (cursor pagination)

import type { Provider } from "./types.js";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /**
     * JSON text for most endpoints, or FormData for the multipart send
     * endpoints. FormData must be passed through to fetch as an object, never
     * stringified: the runtime reads it to generate the boundary.
     */
    body?: string | FormData;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface UnipileClientOptions {
  /** Dashboard-provided host, e.g. "api8.unipile.com:13443" or a full URL. */
  dsn: string;
  /** Access token, sent as the X-API-KEY header. */
  apiKey: string;
  /** Injectable fetch. Defaults to global fetch. */
  fetch?: FetchLike;
}

export class UnipileApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Unipile API error ${status}: ${body.slice(0, 500)}`);
    this.name = "UnipileApiError";
    this.status = status;
    this.body = body;
  }
}

/** Response envelope shared by Unipile's list endpoints. */
export interface UnipileList<T> {
  object?: string;
  items: T[];
  /** Null when there are no further pages. */
  cursor: string | null;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  /** Passed defensively so Unipile rejects a chat not owned by the account. */
  accountId?: string;
}

export interface StartChatInput {
  accountId: string;
  /** Provider ids of the recipients (LinkedIn provider/messaging ids). */
  attendeesIds: string[];
  text?: string;
}

export interface ListChatsInput {
  accountId: string;
  accountType?: Provider;
  limit?: number;
  cursor?: string;
}

export interface ListMessagesInput {
  chatId: string;
  limit?: number;
  cursor?: string;
}

export interface ListChatAttendeesInput {
  chatId: string;
  limit?: number;
  cursor?: string;
}

export interface RetrieveProfileInput {
  /**
   * The profile to retrieve. For LinkedIn this is the member's provider_id
   * (the `ACoAA...` value carried on every attendee) or its public_identifier.
   */
  identifier: string;
  /** The connected account whose session performs the lookup. */
  accountId: string;
}

/**
 * The custom header Unipile is configured to attach to every delivery. It
 * carries the shared secret; the receiver checks it with verifyWebhook().
 * Unipile does not sign deliveries, so this header IS the authentication.
 * Matches the header verifyWebhook() reads (case-insensitive).
 */
export const DEFAULT_WEBHOOK_AUTH_HEADER = "X-Unipile-Auth";

/**
 * The Unipile webhook "source" (which stream to subscribe to). "messaging"
 * is the new-message stream this integration ingests; the others exist so
 * the same method can register the account-status or other streams later.
 */
export type WebhookSource =
  | "messaging"
  | "account_status"
  | "users"
  | "mailing";

export interface CreateWebhookInput {
  /** Public URL Unipile POSTs deliveries to. */
  requestUrl: string;
  /** Which Unipile stream to subscribe to. Defaults to "messaging". */
  source?: WebhookSource;
  /** Custom auth header name. Defaults to X-Unipile-Auth. */
  authHeaderName?: string;
  /** Value for the auth header: the shared webhook secret. */
  authHeaderValue: string;
  /** Optional label; Unipile echoes it back as webhook_name on deliveries. */
  name?: string;
}

function normalizeBaseUrl(dsn: string): string {
  const trimmed = dsn.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return `${withScheme}/api/v1`;
}

export class UnipileClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: UnipileClientOptions) {
    if (!options.dsn) throw new Error("UnipileClient: dsn is required");
    if (!options.apiKey) throw new Error("UnipileClient: apiKey is required");
    this.baseUrl = normalizeBaseUrl(options.dsn);
    this.apiKey = options.apiKey;
    const injected = options.fetch;
    if (injected) {
      this.fetchImpl = injected;
    } else if (typeof fetch !== "undefined") {
      this.fetchImpl = fetch as unknown as FetchLike;
    } else {
      throw new Error(
        "UnipileClient: no fetch available; pass options.fetch",
      );
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Issue a request. Pass `body` for a JSON endpoint, or `form` for one of the
   * multipart endpoints; they are mutually exclusive.
   *
   * A `form` request deliberately sends NO content-type header. multipart/form-data
   * is only parseable with the boundary that delimits its parts, and that
   * boundary is generated by the runtime when it serializes the FormData.
   * Setting the header by hand yields a boundary-less content-type and the
   * server cannot parse the body.
   */
  private async request<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      form?: FormData;
    },
  ): Promise<T> {
    if (opts?.body !== undefined && opts?.form !== undefined) {
      throw new Error("UnipileClient: pass body or form, not both");
    }
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      "X-API-KEY": this.apiKey,
      accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (opts?.form !== undefined) {
      body = opts.form;
    } else if (opts?.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url, { method, headers, body });
    const raw = await res.text();
    if (!res.ok) {
      throw new UnipileApiError(res.status, raw);
    }
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  }

  /**
   * Create a Unipile hosted-auth-wizard link. The user opens the returned
   * URL, logs into LinkedIn, and Unipile connects the account and calls the
   * notify webhook. The exact body params (providers, expiresOn, redirect
   * and notify URLs) are finalized when S2 wires the real connect flow;
   * this passes the caller's body through unchanged so the contract can be
   * pinned there. Endpoint: POST /hosted/accounts/link.
   */
  async createHostedAuthLink(
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("POST", "/hosted/accounts/link", { body });
  }

  /**
   * Register a webhook so Unipile delivers events to `requestUrl`. Because
   * Unipile does not sign deliveries, we attach a custom auth header (default
   * X-Unipile-Auth = the shared secret) that the receiver checks with
   * verifyWebhook(). One-time setup; keep it idempotent at the call site by
   * listing first (see listWebhooks). Endpoint: POST /webhooks.
   */
  async createWebhook(input: CreateWebhookInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      source: input.source ?? "messaging",
      request_url: input.requestUrl,
      headers: [
        {
          key: input.authHeaderName ?? DEFAULT_WEBHOOK_AUTH_HEADER,
          value: input.authHeaderValue,
        },
      ],
    };
    if (input.name !== undefined) body["name"] = input.name;
    return this.request("POST", "/webhooks", { body });
  }

  /** List registered webhooks (used to make registration idempotent). */
  async listWebhooks(): Promise<UnipileList<unknown>> {
    return this.listRequest("/webhooks", {});
  }

  /** Delete a webhook by its Unipile id. */
  async deleteWebhook(webhookId: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/webhooks/${encodeURIComponent(webhookId)}`,
    );
  }

  /**
   * Reply into an existing chat.
   *
   * multipart/form-data, NOT JSON. Unipile's send endpoints accept file fields
   * (attachments, voice_message, video_message) and reject a JSON body, which
   * makes the send fail before it leaves. See qandaba-os#622: this was wrong
   * from the first release and no OS-initiated send ever succeeded.
   */
  async sendMessage(input: SendMessageInput): Promise<unknown> {
    const form = new FormData();
    form.append("text", input.text);
    if (input.accountId) form.append("account_id", input.accountId);
    return this.request(
      "POST",
      `/chats/${encodeURIComponent(input.chatId)}/messages`,
      { form },
    );
  }

  /**
   * Start a new chat with one or more recipients. multipart/form-data, for the
   * same reason as sendMessage.
   *
   * attendees_ids is an array, appended as a repeated field. Unlike the reply
   * path, this encoding is NOT yet confirmed against the live API, because
   * confirming it means opening a chat with a real stranger. If a cold start
   * ever fails while replies work, the repeated-field encoding is the first
   * thing to check (bracketed `attendees_ids[]` is the likely alternative).
   */
  async startChat(input: StartChatInput): Promise<unknown> {
    const form = new FormData();
    form.append("account_id", input.accountId);
    for (const id of input.attendeesIds) form.append("attendees_ids", id);
    if (input.text !== undefined) form.append("text", input.text);
    return this.request("POST", "/chats", { form });
  }

  /**
   * Coerce a list response into a guaranteed envelope. A well-behaved
   * Unipile response already has this shape, but a truncated or empty 200
   * (proxy hiccup mid-backfill) would otherwise leave `items` undefined and
   * make iteration throw. Fail safe to an empty page instead.
   */
  private async listRequest(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<UnipileList<unknown>> {
    const raw = await this.request<Partial<UnipileList<unknown>>>("GET", path, {
      query,
    });
    return {
      object: raw.object,
      items: Array.isArray(raw.items) ? raw.items : [],
      cursor: raw.cursor ?? null,
    };
  }

  /** One page of chats. */
  async listChats(input: ListChatsInput): Promise<UnipileList<unknown>> {
    // account_type is uppercased to Unipile's wire enum. LinkedIn (the only
    // provider exercised today) round-trips cleanly. Note: our normalizer
    // maps both "X" and "TWITTER" to provider "x", but Unipile's list filter
    // expects "TWITTER"; if X is ever enabled, map "x" -> "TWITTER" here.
    return this.listRequest("/chats", {
      account_id: input.accountId,
      account_type: input.accountType
        ? input.accountType.toUpperCase()
        : undefined,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  /** One page of messages in a chat. */
  async listMessages(
    input: ListMessagesInput,
  ): Promise<UnipileList<unknown>> {
    return this.listRequest(
      `/chats/${encodeURIComponent(input.chatId)}/messages`,
      { limit: input.limit, cursor: input.cursor },
    );
  }

  /** One page of a chat's attendees (names + provider ids + profile URLs). */
  async listChatAttendees(
    input: ListChatAttendeesInput,
  ): Promise<UnipileList<unknown>> {
    return this.listRequest(
      `/chats/${encodeURIComponent(input.chatId)}/attendees`,
      { limit: input.limit, cursor: input.cursor },
    );
  }

  /**
   * Retrieve a single profile by identifier. For LinkedIn this resolves an
   * opaque provider_id to the member's public_identifier (the vanity slug),
   * which is what a host stores as a contact's linkedin_url. Returns the raw
   * response object; map it with mapUserProfile(). Endpoint:
   * GET /users/{identifier}?account_id=... The account_id query is required:
   * the lookup runs through that connected account's LinkedIn session.
   */
  async retrieveProfile(input: RetrieveProfileInput): Promise<unknown> {
    return this.request(
      "GET",
      `/users/${encodeURIComponent(input.identifier)}`,
      { query: { account_id: input.accountId } },
    );
  }

  /**
   * Follow a cursor-paginated list endpoint to exhaustion, yielding each item.
   * One place so a pagination fix (here: the non-advancing-cursor guard) is
   * made once, not in three copies.
   *
   * Guard: if an endpoint ever returns the SAME non-null cursor twice in a row
   * (a proxy/bug echoing a fixed cursor), stop instead of looping forever. A
   * runaway fetch loop would otherwise hang a connect-time backfill.
   */
  private async *paginate<I extends { cursor?: string }>(
    listFn: (input: I) => Promise<UnipileList<unknown>>,
    input: I,
  ): AsyncGenerator<unknown, void, void> {
    let cursor = input.cursor;
    do {
      const page = await listFn({ ...input, cursor });
      for (const item of page.items) yield item;
      const next = page.cursor ?? undefined;
      // No progress: the endpoint handed back the same cursor it was given.
      // Stop rather than re-fetch the identical page forever.
      if (next !== undefined && next === cursor) return;
      cursor = next;
    } while (cursor);
  }

  /**
   * Async-iterate every message in a chat, following the cursor until it is
   * null. This is the history-backfill primitive S4 builds on. Callers can
   * `for await (const msg of client.iterateMessages(...))`. Un-throttled: a
   * caller that must respect a rate ceiling paces at its own call site.
   */
  iterateMessages(
    input: ListMessagesInput,
  ): AsyncGenerator<unknown, void, void> {
    return this.paginate((i) => this.listMessages(i), input);
  }

  /**
   * Async-iterate every chat on the account, following the cursor until it is
   * null. The other half of the backfill primitive: enumerate chats, then
   * iterateMessages per chat.
   */
  iterateChats(input: ListChatsInput): AsyncGenerator<unknown, void, void> {
    return this.paginate((i) => this.listChats(i), input);
  }

  /** Async-iterate every attendee of a chat, following the cursor. */
  iterateChatAttendees(
    input: ListChatAttendeesInput,
  ): AsyncGenerator<unknown, void, void> {
    return this.paginate((i) => this.listChatAttendees(i), input);
  }
}
