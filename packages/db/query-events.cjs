const { Client } = require("pg");

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error("Pass run id as argument");

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const events = await c.query(`
    select seq, stage, level, message, data
    from run_events
    where run_id = $1
    order by seq
  `, [runId]);

  for (const row of events.rows) {
    console.log("\n#", row.seq, row.stage, row.level);
    console.log(row.message);
    console.log(JSON.stringify(row.data, null, 2));
  }

  await c.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
