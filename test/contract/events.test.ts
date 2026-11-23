import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_SPECS, EventType, MEDIA_EVENTS, REVIEW_EVENTS } from "../../src/webhooks";

/** Event type => its payload field names, from the vendored events.md. */
function documentedEvents(): Record<string, string[]> {
  const raw = readFileSync(
    join(__dirname, "..", "..", "testdata", "contract", "events.md"),
    "utf8",
  );
  const headings = [...raw.matchAll(/^### ([a-z_.]+)$/gm)];
  const out: Record<string, string[]> = {};
  headings.forEach((heading, i) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[i + 1]?.index ?? raw.length;
    out[heading[1] as string] = [...raw.slice(start, end).matchAll(/^\| `([a-z_]+)` \|/gm)].map(
      (m) => m[1] as string,
    );
  });
  return out;
}

describe("webhook events", () => {
  it("match the vendored events.md in both directions", () => {
    const documented = documentedEvents();
    const families: Record<string, keyof typeof EVENT_SPECS> = {
      [EventType.ENTITY_RATING_CHANGED]: "RatingChangedEvent",
      [EventType.AUTHOR_ERASED]: "AuthorErasedEvent",
    };
    for (const type of REVIEW_EVENTS) families[type] = "ReviewEvent";
    for (const type of MEDIA_EVENTS) families[type] = "MediaEvent";
    expect(Object.keys(families).sort()).toEqual(Object.keys(documented).sort());
    expect(Object.values(EventType).sort()).toEqual(Object.keys(documented).sort());
    const wire = (name: keyof typeof EVENT_SPECS) =>
      Object.values(EVENT_SPECS[name] as Record<string, readonly [string, unknown]>).map(
        ([w]) => w,
      );
    for (const [type, fields] of Object.entries(documented)) {
      const payload = families[type] as keyof typeof EVENT_SPECS;
      for (const field of fields) {
        expect(wire(payload), `${type}: ${payload} lacks ${field}`).toContain(field);
      }
    }
    // Each payload field appears in at least one documented type of its family.
    for (const payload of new Set(Object.values(families))) {
      const documentedFields = Object.entries(families)
        .filter(([, family]) => family === payload)
        .flatMap(([type]) => documented[type] ?? []);
      for (const field of wire(payload)) {
        expect(documentedFields, `${payload}.${field} is documented by no event type`).toContain(
          field,
        );
      }
    }
  });
});
