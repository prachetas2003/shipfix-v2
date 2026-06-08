const express = require("express");
const { API_URL } = require("./config");

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => res.json({ api: API_URL }));

app.listen(port);
