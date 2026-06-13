import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET() {
  const { rows } = await pool.query("SELECT id, title FROM todos ORDER BY id");
  return Response.json(rows);
}
