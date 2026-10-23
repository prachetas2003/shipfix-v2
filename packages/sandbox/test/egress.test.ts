import { describe, expect, it } from "vitest";
import { parseResolvedAddresses, safeLookupHosts } from "../src/egress";

describe("database egress addresses", () => {
  it("keeps only real IP addresses from resolver output", () => {
    expect(parseResolvedAddresses("1.2.3.4\n2001:db8::1 not-an-ip postgres://secret@host")).toEqual([
      "1.2.3.4",
      "2001:db8::1",
    ]);
  });

  it("drops hosts that are not plain domain names", () => {
    expect(safeLookupHosts([" ep-example.c-7.aws.neon.tech ", "localhost", "bad host", "https://example.com"])).toEqual([
      "ep-example.c-7.aws.neon.tech",
    ]);
  });
});
