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
    body?: string;
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

  private async request<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    },
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      "X-API-KEY": this.apiKey,
      accept: "application/json",
    };
    let body: string | undefined;
    if (opts?.body !== undefined) {
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

  /** Reply into an existing chat. */
  async sendMessage(input: SendMessageInput): Promise<unknown> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.accountId) body["account_id"] = input.accountId;
    return this.request(
      "POST",
      `/chats/${encodeURIComponent(input.chatId)}/messages`,
      { body },
    );
  }

  /** Start a new chat with one or more recipients. */
  async startChat(input: StartChatInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      account_id: input.accountId,
      attendees_ids: input.attendeesIds,
    };
    if (input.text !== undefined) body["text"] = input.text;
    return this.request("POST", "/chats", { body });
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

  /**
   * Async-iterate every message in a chat, following the cursor until it is
   * null. This is the history-backfill primitive S4 builds on. Callers can
   * `for await (const msg of client.iterateMessages(...))`.
   */
  async *iterateMessages(
    input: ListMessagesInput,
  ): AsyncGenerator<unknown, void, void> {
    let cursor = input.cursor;
    do {
      const page = await this.listMessages({ ...input, cursor });
      for (const item of page.items) yield item;
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
}
