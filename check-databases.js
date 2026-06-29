const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function run() {
  console.log("Connecting to MySQL...");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });
  console.log("Connected.");

  const [dbs] = await conn.execute("SHOW DATABASES");
  console.log("\nDatabases on server:");
  for (const db of dbs) {
    console.log(`- ${db.Database || db.schema_name}`);
  }

  await conn.end();
}

run().catch(console.error);
