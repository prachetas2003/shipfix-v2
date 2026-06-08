const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN }));

app.get("/todos", (_req, res) => {
  res.json([]);
});

app.listen(port);
