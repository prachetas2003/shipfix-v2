import { describe, expect, it } from "vitest";
import {
  isPoolerUri,
  migrateConnectionUrl,
  parseNeonConnectionSecret,
  runtimeConnectionUrl,
  selectNeonConnectionUrls,
  serializeNeonConnectionSecret,
} from "../src/neonConnections";

describe("neonConnections", () => {
  it("detects pooler hosts", () => {
    expect(isPoolerUri("postgres://u:p@ep-x-pooler.neon.tech/db")).toBe(true);
    expect(isPoolerUri("postgres://u:p@ep-x.neon.tech/db")).toBe(false);
  });

  it("selects pooled vs direct from mixed URIs", () => {
    const urls = selectNeonConnectionUrls([
      "postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require",
      "postgres://u:p@ep-x.neon.tech/db?sslmode=require",
    ]);
    expect(urls).toEqual({
      pooled: "postgres://u:p@ep-x-pooler.neon.tech/db?sslmode=require",
      direct: "postgres://u:p@ep-x.neon.tech/db?sslmode=require",
      singleUri: false,
    });
  });

  it("duplicates a single URI for both roles", () => {
    const urls = selectNeonConnectionUrls(["postgres://u:p@ep-x.neon.tech/db"]);
    expect(urls?.singleUri).toBe(true);
    expect(urls?.pooled).toBe(urls?.direct);
  });

  it("round-trips JSON secrets and accepts legacy plain URLs", () => {
    const urls = {
      pooled: "postgres://pool",
      direct: "postgres://direct",
      singleUri: false,
    };
    const secret = serializeNeonConnectionSecret(urls);
    expect(parseNeonConnectionSecret(secret)).toEqual({
      pooled: "postgres://pool",
      direct: "postgres://direct",
      singleUri: false,
    });
    expect(parseNeonConnectionSecret("postgres://legacy")).toEqual({
      pooled: "postgres://legacy",
      direct: "postgres://legacy",
      singleUri: true,
    });
    expect(runtimeConnectionUrl(urls)).toBe("postgres://pool");
    expect(migrateConnectionUrl(urls)).toBe("postgres://direct");
  });
});
