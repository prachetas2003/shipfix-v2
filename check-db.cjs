const { Client } = require("pg");

async function main() {
  console.log("DATABASE_URL present:", Boolean(process.env.DATABASE_URL));

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const result = await c.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `);

  console.log(result.rows.map((x) => x.table_name));

  await c.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
