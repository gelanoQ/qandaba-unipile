// verifyWebhook(): authenticate an incoming Unipile webhook request.
//
// Unipile does NOT sign webhook payloads (no HMAC, no signature header)
// and does not issue a secret. Instead the integrator attaches a custom
// header with a self-chosen value when registering the webhook, and the
// receiver checks it. We standardize that header as `X-Unipile-Auth` and
// compare its value against the shared secret in constant time.
//
// Confirmed from developer.unipile.com/docs/webhooks-2.

import { timingSafeEqual } from "node:crypto";

/** The custom header Unipile is configured to send (value = the secret). */
export const UNIPILE_AUTH_HEADER = "x-unipile-auth";

/**
 * A minimal, framework-agnostic view of request headers: either a plain
 * object (Next.js route handlers can produce this) or a Headers instance
 * (the web Fetch API). Header names are matched case-insensitively.
 */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  const lower = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(lower);
  }
  // Plain object: match case-insensitively.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = (headers as Record<string, string | string[] | undefined>)[
        key
      ];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    }
  }
  return null;
}

/**
 * Compare two strings for equality. Length is compared first (unavoidable
 * with timingSafeEqual, and acceptable to leak for a shared-secret header);
 * equal-length values are then compared in constant time.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers. Comparing lengths first
  // is unavoidable; do the byte comparison in constant time regardless.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Returns true iff the request carries the `X-Unipile-Auth` header with a
 * value equal to `secret`. Missing header, empty secret, or any mismatch
 * returns false. Never throws.
 */
export function verifyWebhook(headers: HeaderSource, secret: string): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  const provided = readHeader(headers, UNIPILE_AUTH_HEADER);
  if (provided === null || provided.length === 0) return false;
  return safeEqual(provided, secret);
}
