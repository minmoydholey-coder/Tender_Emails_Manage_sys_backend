const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

async function listTokens() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const [rows] = await conn.execute(`
      SELECT matched_token, COUNT(*) as count
      FROM tender_matches
      GROUP BY matched_token
      ORDER BY count DESC
    `);

    console.log(`Unique matched tokens in DB (${rows.length}):`);
    rows.forEach(r => {
      console.log(` - "${r.matched_token}" (matched ${r.count} times)`);
    });
  } catch (err) {
    console.error(err);
  } finally {
    await conn.end();
  }
}

listTokens();
