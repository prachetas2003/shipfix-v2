const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3001;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Permissive CORS so A1 can stay Green without CORS_ORIGIN user_secret (A3 wires origins).
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/todos", async (_req, res) => {
  const result = await pool.query("SELECT 1 AS ok");
  res.json(result.rows);
});

app.listen(port);
