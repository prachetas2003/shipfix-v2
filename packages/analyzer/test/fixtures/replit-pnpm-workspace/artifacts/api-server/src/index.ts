import express from "express";
import { db } from "@workspace/db";

const app = express();
const port = Number(process.env.PORT);
const logLevel = process.env.LOG_LEVEL ?? "info";

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok", logLevel });
});

app.get("/api/items", async (_req, res) => {
  res.json(await db.query.items.findMany());
});

app.listen(port);
