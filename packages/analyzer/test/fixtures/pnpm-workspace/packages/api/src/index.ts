import Fastify from "fastify";

const app = Fastify();
const port = Number(process.env.PORT) || 3000;

app.get("/health", async () => ({ ok: true }));

app.listen({ port });
