const express = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const app = express();
const port = process.env.PORT || 8080;

// Prisma reads process.env.DATABASE_URL from the datasource block.
app.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

app.listen(port);
