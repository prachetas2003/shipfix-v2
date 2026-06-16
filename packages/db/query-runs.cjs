const { Client } = require("pg");

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const runs = await c.query(`
    select id, mode, status, started_at, finished_at
    from runs
    order by started_at desc
    limit 10
  `);

  console.table(runs.rows);

  await c.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
