import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapUserProfile } from "../src/profile.js";
import { UnipileClient, type FetchLike } from "../src/client.js";

function fixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("mapUserProfile", () => {
  it("extracts the public identifier and builds a canonical vanity URL", () => {
    const p = mapUserProfile(fixture("user-profile.json"));
    expect(p.providerId).toBe("ACoAAADWdH8B_x");
    expect(p.publicIdentifier).toBe("philipngai");
    // This is the value a host matches against a stored contact linkedin_url.
    expect(p.linkedinUrl).toBe("https://www.linkedin.com/in/philipngai");
    expect(p.name).toBe("Philip Ngai");
  });

  it("uses a whole `name` when present over first/last", () => {
    const p = mapUserProfile({
      provider_id: "ACoAA1",
      public_identifier: "jdoe",
      name: "J. Doe",
      first_name: "John",
      last_name: "Doe",
    });
    expect(p.name).toBe("J. Doe");
  });

  it("returns an all-null profile (no vanity URL) when public_identifier is absent", () => {
    // A private/unreachable profile: enrichment must degrade to a miss, not
    // fabricate a URL, so the host leaves the message unmatched.
    const p = mapUserProfile({ provider_id: "ACoAA2", first_name: "No", last_name: "Slug" });
    expect(p.publicIdentifier).toBeNull();
    expect(p.linkedinUrl).toBeNull();
    expect(p.providerId).toBe("ACoAA2");
    expect(p.name).toBe("No Slug");
  });

  it("never throws on malformed input", () => {
    expect(mapUserProfile(null)).toEqual({
      headline: null,
      company: null,
      title: null,
      providerId: null,
      publicIdentifier: null,
      linkedinUrl: null,
      name: null,
      email: null,
      phone: null,
    });
    expect(mapUserProfile("nonsense").publicIdentifier).toBeNull();
    expect(mapUserProfile(42).linkedinUrl).toBeNull();
  });
});

interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

function stubFetch(body: unknown): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

describe("UnipileClient.retrieveProfile", () => {
  it("GETs /users/{identifier} with the account_id query and API key header", async () => {
    const { fetch, calls } = stubFetch(fixture("user-profile.json"));
    const client = new UnipileClient({ dsn: "api.local:443", apiKey: "k", fetch });

    const raw = await client.retrieveProfile({
      identifier: "ACoAAADWdH8B_x",
      accountId: "acc1",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/users/ACoAAADWdH8B_x");
    expect(url.searchParams.get("account_id")).toBe("acc1");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers?.["X-API-KEY"]).toBe("k");
    // The raw response maps cleanly through mapUserProfile.
    expect(mapUserProfile(raw).publicIdentifier).toBe("philipngai");
  });

  it("URL-encodes an identifier containing reserved characters", async () => {
    const { fetch, calls } = stubFetch({});
    const client = new UnipileClient({ dsn: "api.local:443", apiKey: "k", fetch });
    await client.retrieveProfile({ identifier: "a b/c", accountId: "acc1" });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/users/a%20b%2Fc");
  });
});

/**
 * v0.5.0: headline, company and title.
 *
 * Read the caveat on UserProfile.company before extending these. `headline` is
 * proven by the committed fixture; the work_experience field names are from
 * Unipile's documented shape, not from a live response anyone inspected. The
 * host's live-call test is what confirms them, exactly as it did for
 * public_identifier in v0.4.0.
 */
describe("mapUserProfile: headline, company and title (v0.5.0)", () => {
  it("extracts the headline from the committed fixture", () => {
    expect(mapUserProfile(fixture("user-profile.json")).headline).toBe("Founder & CEO");
  });

  it("extracts company and title from the current work-experience entry", () => {
    const p = mapUserProfile({
      provider_id: "ACoAA1",
      public_identifier: "jdoe",
      work_experience: [
        { company: "Acme Corporation", position: "VP of Engineering" },
      ],
    });
    expect(p.company).toBe("Acme Corporation");
    expect(p.title).toBe("VP of Engineering");
  });

  it("prefers the OPEN-ENDED role over a listed-first past one", () => {
    // Guards the case where the ordering is not most-recent-first: a member
    // must not have an old job reported as their current one.
    const p = mapUserProfile({
      work_experience: [
        { company: "Old Corp", position: "Intern", end: "2020-01-01" },
        { company: "Acme Corporation", position: "VP of Engineering" },
      ],
    });
    expect(p.company).toBe("Acme Corporation");
    expect(p.title).toBe("VP of Engineering");
  });

  it("falls back to the first entry when every role has an end date", () => {
    const p = mapUserProfile({
      work_experience: [
        { company: "Recent Corp", position: "Lead", end: "2025-01-01" },
        { company: "Older Corp", position: "Junior", end: "2020-01-01" },
      ],
    });
    expect(p.company).toBe("Recent Corp");
  });

  it("accepts `title` as an alias for `position`", () => {
    // Hedging the documented-but-unverified field name: if the live response
    // spells it `title`, this still resolves rather than silently returning null.
    const p = mapUserProfile({ work_experience: [{ company: "Acme", title: "CTO" }] });
    expect(p.title).toBe("CTO");
  });

  it("yields nulls, not a throw, for a profile with no work history", () => {
    for (const history of [undefined, [], "not-an-array", [null], [{}]]) {
      const p = mapUserProfile({ provider_id: "ACoAA2", work_experience: history });
      expect(p.company).toBeNull();
      expect(p.providerId).toBe("ACoAA2");
    }
  });

  it("leaves the v0.4.0 fields untouched, so existing consumers are unaffected", () => {
    const p = mapUserProfile(fixture("user-profile.json"));
    expect(p.providerId).toBe("ACoAAADWdH8B_x");
    expect(p.publicIdentifier).toBe("philipngai");
    expect(p.linkedinUrl).toBe("https://www.linkedin.com/in/philipngai");
    expect(p.name).toBe("Philip Ngai");
  });
});

describe("mapUserProfile: contact_info email and phone (v0.6.0)", () => {
  // Shape copied from a live response, not invented: LinkedIn returns
  // contact_info on the DEFAULT profile call for first-degree connections,
  // and v0.5.0 dropped it on the floor.
  const withContact = {
    public_identifier: "ryan-glenn-53559b39",
    first_name: "Ryan",
    last_name: "Glenn",
    contact_info: {
      emails: ["rtglenn19@gmail.com"],
      phones: ["404-406-7313"],
    },
  };

  it("extracts the first email and the first phone", () => {
    const p = mapUserProfile(withContact);
    expect(p.email).toBe("rtglenn19@gmail.com");
    expect(p.phone).toBe("404-406-7313");
  });

  it("maps phones without emails, the shape a partial profile actually returns", () => {
    const p = mapUserProfile({
      public_identifier: "sanjaypandeyqss",
      contact_info: { adresses: ["Minneapolis "], phones: ["+1 (612) 201-1169"] },
    });
    expect(p.email).toBeNull();
    expect(p.phone).toBe("+1 (612) 201-1169");
  });

  it("yields nulls when contact_info is absent, which is the 2nd/3rd degree case", () => {
    const p = mapUserProfile({ public_identifier: "kstreeter", headline: "Navy Veteran" });
    expect(p.email).toBeNull();
    expect(p.phone).toBeNull();
  });

  it("survives every malformed contact_info shape rather than throwing", () => {
    for (const contact_info of [
      null,
      "nope",
      [],
      { emails: [], phones: [] },
      { emails: "a@b.c", phones: 5 },
      { emails: [null], phones: [{}] },
    ]) {
      const p = mapUserProfile({ public_identifier: "x", contact_info });
      expect(p.email).toBeNull();
      expect(p.phone).toBeNull();
    }
  });

  it("treats a whitespace-only entry as absent, not as a value", () => {
    // A blank string reaching a form is worse than a null: it looks prefilled,
    // suppresses the "only fill what is blank" guard downstream, and saves an
    // empty contact detail nobody typed.
    const p = mapUserProfile({
      public_identifier: "x",
      contact_info: { emails: ["   "], phones: ["\t\n"] },
    });
    expect(p.email).toBeNull();
    expect(p.phone).toBeNull();
  });

  it("skips a blank leading entry and takes the first real one", () => {
    const p = mapUserProfile({
      public_identifier: "x",
      contact_info: { emails: ["  ", "real@example.com"], phones: [null, "555-0100"] },
    });
    expect(p.email).toBe("real@example.com");
    expect(p.phone).toBe("555-0100");
  });

  it("leaves the v0.5.0 fields untouched, so existing consumers are unaffected", () => {
    const p = mapUserProfile(withContact);
    expect(p.publicIdentifier).toBe("ryan-glenn-53559b39");
    expect(p.linkedinUrl).toBe("https://www.linkedin.com/in/ryan-glenn-53559b39");
    expect(p.name).toBe("Ryan Glenn");
  });
});
