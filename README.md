# @qandaba/unipile

Portable, host-agnostic core for the Unipile messaging integration. It
turns Unipile LinkedIn webhooks into a canonical `MessageEvent`, verifies
webhook authenticity, and wraps the Unipile REST endpoints this
integration needs. No database, no framework. A host application
(qandaba-os, bcs-lead-engine) implements one small adapter to persist
events into its own schema.

This package is consumed as a git dependency, not from a registry:

```json
"dependencies": {
  "@qandaba/unipile": "github:gelanoQ/qandaba-unipile#v0.1.0"
}
```

npm builds it on install via the `prepare` script.

## The seam

```ts
import type { MessageEvent, HostAdapter } from "@qandaba/unipile";

class MyAdapter implements HostAdapter {
  async persistMessage(event: MessageEvent): Promise<void> {
    // resolve the contact by event.sender.linkedinUrl, insert a touch keyed
    // on event.externalId for idempotency, route unknown senders to review.
  }
}
```

## Behavior

### normalize(payload)

Pure and total: it never throws. Maps a raw Unipile "new message" webhook
payload to a `MessageEvent`, or returns `{ ok: false, reason }` for
malformed or unhandled input.

```ts
import { normalize } from "@qandaba/unipile";

const result = normalize(rawWebhookBody);
if (result.ok) {
  await adapter.persistMessage(result.event);
} else {
  logger.warn("dropped unipile event", result.reason, result.detail);
}
```

Direction gotcha: the webhook carries no `is_sender` flag. `normalize`
derives direction by comparing `account_info.user_id` (the connected
user's own provider id) against `sender.attendee_provider_id`. Equal means
the connected account sent it (`outbound`); otherwise `inbound`. When
either id is missing it defaults to `inbound`, which keeps unknown senders
reviewable.

### verifyWebhook(headers, secret)

Unipile does not sign webhook payloads (no HMAC, no signature) and issues
no secret. Instead the integrator attaches a custom header when
registering the webhook. This package standardizes that header as
`X-Unipile-Auth` and compares it against your shared secret in constant
time.

```ts
import { verifyWebhook } from "@qandaba/unipile";

if (!verifyWebhook(req.headers, process.env.UNIPILE_WEBHOOK_SECRET!)) {
  return new Response("unauthorized", { status: 401 });
}
```

Accepts a plain header object or a `Headers` instance; matches the header
name case-insensitively.

### UnipileClient

A thin, dependency-free wrapper over the Unipile REST API. Auth is the
`X-API-KEY` header; base URL is `https://{dsn}/api/v1`. `fetch` is
injectable so the client is fully unit-testable offline.

```ts
import { UnipileClient } from "@qandaba/unipile";

const client = new UnipileClient({
  dsn: process.env.UNIPILE_DSN!, // e.g. "api8.unipile.com:13443"
  apiKey: process.env.UNIPILE_API_KEY!,
});

await client.sendMessage({ chatId, text, accountId });      // reply
await client.startChat({ accountId, attendeesIds, text });  // new chat
for await (const message of client.iterateMessages({ chatId })) {
  // history backfill: follows the cursor until it is null
}
```

`createHostedAuthLink(body)` wraps `POST /hosted/accounts/link` for the
connect flow; its exact body params are pinned by the host in S2.

#### retrieveProfile and the sections trap

```ts
// v0.5.0 and any caller that omits `sections`:
const raw = await client.retrieveProfile({ identifier, accountId });
mapUserProfile(raw).company; // ALWAYS null, for every profile on earth

// What you actually want when you need employer and job title:
const raw = await client.retrieveProfile({
  identifier, accountId, sections: ["experience"],
});
mapUserProfile(raw).company; // the member's current employer
```

Unipile returns work history only when asked for it. Without `sections` the
response carries no work-experience key at all, so `company` and `title` come
back null for everyone and nothing reports an error. Ask for the section when
you need those two fields, and leave it off when you do not: bulk callers that
want only the vanity URL should not pay for data they never read.

Each entry goes on the wire as its own `linkedin_sections` param
(`?linkedin_sections=experience&linkedin_sections=education`). Unipile validates
one section name per value against an enum, so a comma-joined
`experience,education` is read as a single unknown name and 400s the entire
lookup. Do not pre-join them, and do not pass a blank string: an empty
`linkedin_sections=` fails the same enum. The client trims and drops blanks for
you, so a stray `""` costs nothing. Valid values are `*`, `*_preview`, `about`,
`experience`, `education`, `languages`, `skills`, `certifications`,
`volunteering_experience`, `projects`, `recommendations_received`,
`recommendations_given`, `recruiting_activity`, and a `_preview` variant of each.

`email` and `phone` come from `contact_info` on the default call, no section
needed, and are populated only for members who share them (in practice,
first-degree connections). Null is the normal case there, not a bad request.

### History backfill (REST)

Live capture normalizes the webhook payload. Backfill instead reads history
from REST, whose message objects have a different shape (`text` not `message`,
no `event`/`account_info`, direction carried as `is_sender`, sender given as a
bare `sender_id`). `mapRestMessage(item, ctx)` maps a REST message plus the
chat's attendees to the SAME canonical `MessageEvent` as `normalize()`, keyed on
the same `chatId:messageId` externalId, so a backfilled message and the same
message delivered live dedupe against each other.

```ts
import { mapRestAttendees, mapRestMessage, UnipileClient } from "@qandaba/unipile";

const raw = [];
for await (const a of client.iterateChatAttendees({ chatId })) raw.push(a);
// mapRestAttendees also reads the is_self flag to find the connected user, so
// the counterparty is picked correctly even when a message omits sender_id.
const { attendees, connectedUserProviderId } = mapRestAttendees(raw);

for await (const item of client.iterateMessages({ chatId })) {
  const result = mapRestMessage(item, {
    accountId,
    chatId, // message objects may not echo chat_id; supply it from the URL
    provider: "linkedin",
    attendees,
    connectedUserProviderId,
  });
  if (result.ok) await adapter.persistMessage(result.event);
}
```

`iterateChats({ accountId })` enumerates the account's chats; pair it with
`iterateChatAttendees` and `iterateMessages` for a full-history backfill. The
iterators are un-throttled and guard against a non-advancing cursor; a caller
that must respect a rate ceiling paces at its own call site.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The whole test suite runs offline against committed fixtures. No live
Unipile call lives here; the one real live call belongs to the host's
webhook-ingest harness (qandaba-os S3).

## License

UNLICENSED. Internal to Qandaba.
