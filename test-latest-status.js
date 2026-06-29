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
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });
  console.log("Connected.");

  // Let's run a test query to find the latest matched email for each tender
  const query = `
    SELECT tm.docket_no, tm.tender_no, t.id as thread_id, t.subject, t.date, t.ai_summary
    FROM tender_matches tm
    JOIN threads t ON tm.thread_db_id = t.id
    WHERE (tm.docket_no, tm.tender_no, t.date) IN (
        SELECT tm2.docket_no, tm2.tender_no, MAX(t2.date)
        FROM tender_matches tm2
        JOIN threads t2 ON tm2.thread_db_id = t2.id
        GROUP BY tm2.docket_no, tm2.tender_no
    )
    LIMIT 10
  `;

  const [rows] = await conn.execute(query);
  console.log(`\nRetrieved ${rows.length} latest matched email records for tenders:`);
  rows.forEach(r => {
    console.log(`- Tender: "${r.tender_no}"`);
    console.log(`  Latest Email Date: ${r.date}`);
    console.log(`  Subject: "${r.subject}"`);
    console.log(`  AI Summary (first 100 chars): "${r.ai_summary ? r.ai_summary.substring(0, 100) : 'none'}"`);
  });

  await conn.end();
}

run().catch(console.error);
