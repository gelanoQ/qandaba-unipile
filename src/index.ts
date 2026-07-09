// @qandaba/unipile public surface.
//
// Host apps import from here. The integration seam is MessageEvent +
// HostAdapter; the behavior is normalize() + verifyWebhook() + UnipileClient.

export type {
  MessageDirection,
  Provider,
  MessageParty,
  MessageEvent,
  HostAdapter,
  NormalizeResult,
  NormalizeFailureReason,
} from "./types.js";

export { normalize } from "./normalize.js";

export { mapRestMessage, mapRestAttendee } from "./backfill.js";
export type { RestMessageContext } from "./backfill.js";

export { verifyWebhook, UNIPILE_AUTH_HEADER } from "./verify.js";
export type { HeaderSource } from "./verify.js";

export {
  UnipileClient,
  UnipileApiError,
  DEFAULT_WEBHOOK_AUTH_HEADER,
} from "./client.js";
export type {
  FetchLike,
  UnipileClientOptions,
  UnipileList,
  SendMessageInput,
  StartChatInput,
  ListChatsInput,
  ListMessagesInput,
  ListChatAttendeesInput,
  WebhookSource,
  CreateWebhookInput,
} from "./client.js";
