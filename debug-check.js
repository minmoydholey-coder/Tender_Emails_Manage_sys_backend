const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { extractTenderTokens, checkMatch } = require('./matcher');

dotenv.config();

const cachePath = path.join(__dirname, 'data', 'sync_cache.json');

async function run() {
  if (!fs.existsSync(cachePath)) {
    console.error("No sync cache found. Please run a sync first or start the server.");
    return;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const participated = cache.tenders.filter(t => t.isParticipated);
  console.log(`Loaded ${participated.length} participated tenders from GSheet cache.`);

  console.log("Connecting to MySQL database...");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });
  console.log("Connected successfully.");

  const table = process.env.DB_TABLE || 'threads';
  console.log(`Fetching all threads from table "${table}"...`);
  const [threads] = await conn.query(`SELECT id, thread_id, subject, body, ocr_text FROM \`${table}\``);
  console.log(`Retrieved ${threads.length} threads.`);

  console.log("Scanning for matches...");
  let matchCount = 0;

  for (const tender of participated) {
    const tokens = extractTenderTokens(tender.tenderNoRaw);
    if (tokens.length === 0) continue;

    for (const thread of threads) {
      const result = checkMatch(tokens, thread.subject, thread.body, thread.ocr_text);
      if (result.matched) {
        matchCount++;
        console.log(`\n🎉 MATCH FOUND #${matchCount}!`);
        console.log(`Tender Client: ${tender.client}`);
        console.log(`Tender No Raw: ${tender.tenderNoRaw}`);
        console.log(`Extracted Tokens: ${JSON.stringify(tokens)}`);
        console.log(`Matched Email Subject: "${thread.subject}"`);
        console.log(`Matched Token: "${result.matchedToken}"`);
        console.log(`Confidence: ${result.confidence}`);
      }
    }
  }

  console.log(`\nScan Complete. Total matches found: ${matchCount}`);
  await conn.end();
}

run().catch(console.error);
