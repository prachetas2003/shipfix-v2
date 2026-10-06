import { describe, expect, it } from "vitest";
import { issueStreamTicket, STREAM_TICKET_TTL_MS, streamTicketKey, verifyStreamTicket } from "../src/streamTicket";

const key = streamTicketKey(["master-key"]);
const runId = "11111111-1111-1111-1111-111111111111";

describe("stream tickets", () => {
  it("authorizes the issuing user for the same run", () => {
    const { ticket } = issueStreamTicket(key, { userId: "user-1", runId, now: 1_000 });
    expect(verifyStreamTicket(key, ticket, runId, 2_000)).toBe("user-1");
  });

  it("rejects other runs, expired tickets, tampering, and other keys", () => {
    const { ticket } = issueStreamTicket(key, { userId: "user-1", runId, now: 1_000 });
    expect(verifyStreamTicket(key, ticket, "22222222-2222-2222-2222-222222222222", 2_000)).toBeNull();
    expect(verifyStreamTicket(key, ticket, runId, 1_000 + STREAM_TICKET_TTL_MS + 1)).toBeNull();
    expect(verifyStreamTicket(key, `${ticket}x`, runId, 2_000)).toBeNull();
    expect(verifyStreamTicket(streamTicketKey(["other"]), ticket, runId, 2_000)).toBeNull();
  });

  it("derives the same key from the same secrets", () => {
    expect(streamTicketKey(["a", undefined, "b"]).equals(streamTicketKey(["a", "b"]))).toBe(true);
  });
});
