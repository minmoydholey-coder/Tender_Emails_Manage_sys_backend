const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { google } = require('googleapis');
const { OpenAI } = require('openai');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const { extractTenderTokens, checkMatch, checkMatchNormalized, checkMatchCompiled, makeTokenRegex } = require('./matcher');

const app = express();
const PORT = process.env.PORT || 5000;
console.log(`Starting Tender Email Sync Server on port ${PORT}...`);

app.use(cors());
app.use(express.json());

// Directories setup
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const CACHE_FILE = path.join(DATA_DIR, 'sync_cache.json');
let lastAiError = null; // Store last AI API error for frontend diagnosis

// AI Client Resolver (supports Groq, local Ollama, and OpenAI)
function getAiClient() {
  const provider = process.env.AI_PROVIDER || 'ollama';
  
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { client: null, model: null, provider, error: 'No OPENAI_API_KEY set in .env file.' };
    }
    return {
      client: new OpenAI({ apiKey }),
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      provider
    };
  } else if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return { client: null, model: null, provider, error: 'No GROQ_API_KEY set in .env file.' };
    }
    return {
      client: new OpenAI({
        baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
        apiKey: apiKey
      }),
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      provider
    };
  } else {
    // Default to ollama
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    const model = process.env.OLLAMA_MODEL || 'gemma4:e4b';
    return {
      client: new OpenAI({
        baseURL,
        apiKey: 'ollama' // Placeholder apiKey required by OpenAI SDK client
      }),
      model,
      provider
    };
  }
}

// Helpers for reading/writing cache
function readCache(file, defaultValue = {}) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error(`Error reading cache file ${file}:`, e);
    }
  }
  return defaultValue;
}

function writeCache(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Error writing cache file ${file}:`, e);
  }
}

// Ensure database tables exist on server start
async function initializeDatabase() {
  try {
    const conn = await getDbConnection();
    console.log('Initializing database tables...');
    
    // Create tender_matches if not exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tender_matches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        docket_no VARCHAR(100),
        tender_no VARCHAR(255),
        thread_db_id INT,
        thread_id VARCHAR(255),
        matched_token VARCHAR(255),
        confidence VARCHAR(50),
        matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_match (docket_no, tender_no, thread_db_id)
      )
    `);

    // Add tender_status column if it doesn't exist
    try {
      await conn.query(`
        ALTER TABLE tender_matches 
        ADD COLUMN tender_status VARCHAR(100) DEFAULT NULL
      `);
      console.log('Added tender_status column to tender_matches table.');
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_FIELDNAME' && !colErr.message.includes('duplicate column')) {
        console.error('Failed to add tender_status column:', colErr.message);
      }
    }

    try {
      await conn.query(`
        ALTER TABLE tender_matches
        ADD COLUMN reply_required TINYINT(1) DEFAULT 0
      `);
      console.log('Added reply_required column to tender_matches table.');
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_FIELDNAME' && !colErr.message.includes('duplicate column')) {
        console.error('Failed to add reply_required column:', colErr.message);
      }
    }

    try {
      await conn.query(`
        ALTER TABLE tender_matches
        ADD COLUMN reply_reason VARCHAR(255) DEFAULT NULL
      `);
      console.log('Added reply_reason column to tender_matches table.');
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_FIELDNAME' && !colErr.message.includes('duplicate column')) {
        console.error('Failed to add reply_reason column:', colErr.message);
      }
    }

    try {
      await conn.query(`
        ALTER TABLE tender_matches
        ADD COLUMN deadline_date DATETIME DEFAULT NULL
      `);
      console.log('Added deadline_date column to tender_matches table.');
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_FIELDNAME' && !colErr.message.includes('duplicate column')) {
        console.error('Failed to add deadline_date column:', colErr.message);
      }
    }

    // Ensure thread_db_id is INT to match threads.id for join performance
    try {
      await conn.query(`
        ALTER TABLE tender_matches
        MODIFY COLUMN thread_db_id INT
      `);
      console.log('Ensured thread_db_id column is INT type.');
    } catch (colErr) {
      console.error('Failed to modify thread_db_id column to INT:', colErr.message);
    }

    // Add index on thread_db_id for faster JOIN lookups
    try {
      await conn.query(`
        ALTER TABLE tender_matches
        ADD INDEX idx_thread_db_id (thread_db_id)
      `);
      console.log('Added index on thread_db_id to tender_matches.');
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_KEYNAME' && !colErr.message.includes('duplicate key')) {
        console.error('Failed to add index on thread_db_id:', colErr.message);
      }
    }

    // Add user_labels column to threads table if not exists for custom email labeling
    try {
      const threadsTable = process.env.DB_TABLE || 'threads';
      await conn.query(`
        ALTER TABLE \`${threadsTable}\`
        ADD COLUMN user_labels VARCHAR(512) DEFAULT NULL
      `);
      console.log(`Added user_labels column to ${threadsTable} table.`);
    } catch (colErr) {
      if (colErr.code !== 'ER_DUP_FIELDNAME' && !colErr.message.includes('duplicate column')) {
        console.error('Failed to add user_labels column:', colErr.message);
      }
    }

    // Delete any existing matches for the blacklisted senders
    const deleteQuery = `
      DELETE tm FROM tender_matches tm
      JOIN threads t ON tm.thread_db_id = t.id
      WHERE t.sender LIKE '%protulchatterjee2020@gmail.com%' 
         OR t.sender LIKE '%biswajit@omclearing.com%'
    `;
    const [delResult] = await conn.query(deleteQuery);
    if (delResult.affectedRows > 0) {
      console.log(`Startup cleanup: Deleted ${delResult.affectedRows} matches from blacklisted senders.`);
    }
    
    await conn.end();
    console.log('Database tables initialized successfully.');
    
    // Diagnostic check for AI connectivity
    testAiConnection();
  } catch (err) {
    console.error('Failed to initialize database tables:', err.message);
  }
}

// Quick validation on server startup
async function testAiConnection() {
  const { client, model, provider, error } = getAiClient();
  if (error) {
    lastAiError = error;
    console.log(`AI initialization skipped: ${error}`);
    return;
  }
  try {
    console.log(`Testing AI connection to ${provider} using model '${model}'...`);
    await client.chat.completions.create({
      model: model,
      messages: [{ role: 'user', content: 'Ping' }],
      max_tokens: 1,
      temperature: 0
    });
    lastAiError = null; // Connection is working!
    console.log(`AI connection successful (${provider} - ${model}).`);
  } catch (err) {
    console.error(`AI connection test failed on startup (${provider} - ${model}):`, err.message);
    lastAiError = err.message;
  }
}

// ----------------------------------------------------
// Robust JSON and Array Extractors for OpenAI Outputs
// ----------------------------------------------------
function extractRuleFromJson(str) {
  if (!str) return { sqlKeywords: [], senderDomain: '' };
  try {
    const cleanStr = str.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanStr);
  } catch (e) {
    const keywordsMatch = str.match(/"sqlKeywords"\s*:\s*\[([^\]]+)\]/);
    const domainMatch = str.match(/"senderDomain"\s*:\s*"([^"]+)"/);
    
    const keywords = [];
    if (keywordsMatch) {
      keywordsMatch[1].split(',').forEach(k => {
        const clean = k.replace(/["']/g, '').trim();
        if (clean) keywords.push(clean);
      });
    }
    
    return {
      sqlKeywords: keywords,
      senderDomain: domainMatch ? domainMatch[1].trim() : ''
    };
  }
}

function extractArrayFromJson(str) {
  if (!str) return [];
  try {
    const cleanStr = str.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanStr);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) return val;
      }
    }
  } catch (e) {
    const match = str.match(/\[\s*\d+\s*(?:,\s*\d+\s*)*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err) {}
    }
  }
  return [];
}

function extractReplyDecisionFromJson(str) {
  if (!str) return null;
  try {
    const cleanStr = str.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanStr);
    if (parsed && typeof parsed === 'object') {
      return {
        required: parsed.hasOwnProperty('required') ? Boolean(parsed.required) : null,
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : null
      };
    }
  } catch (e) {
    const reqMatch = str.match(/"required"\s*:\s*(true|false)/i);
    const reasonMatch = str.match(/"reason"\s*:\s*"([^"]+)"/);
    if (reqMatch || reasonMatch) {
      return {
        required: reqMatch ? reqMatch[1].toLowerCase() === 'true' : null,
        reason: reasonMatch ? reasonMatch[1].trim() : null
      };
    }
  }
  return null;
}

// Run database initialization
initializeDatabase();

// ----------------------------------------------------
// Google Sheets Client Setup
// ----------------------------------------------------
async function getSheetsClient() {
  const credentialsPath = path.join(__dirname, 'credentials.json');
  const tokenPath = path.join(__dirname, 'token.json');

  if (!fs.existsSync(credentialsPath) || !fs.existsSync(tokenPath)) {
    throw new Error('Google Sheets auth files (credentials.json and/or token.json) are missing in the project root.');
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath));
  const token = JSON.parse(fs.readFileSync(tokenPath));

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);

  return google.sheets({ version: 'v4', auth: oAuth2Client });
}

async function getSheetTitleByGid(sheets, spreadsheetId, gid) {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = response.data.sheets.find(s => s.properties.sheetId === Number(gid));
  if (!sheet) {
    throw new Error(`Sheet tab with GID ${gid} not found in spreadsheet.`);
  }
  return sheet.properties.title;
}

async function fetchGoogleSheetTenders() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const gid = process.env.GOOGLE_SHEET_GID;

  const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
  const range = `${title}!A:AG`; // Fetch up to column 33 (AG)

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data.values || [];
}

// ----------------------------------------------------
// MySQL Client Setup
// ----------------------------------------------------
async function getDbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

// Fetches the body and OCR text. To support incremental sync, this query is also parameterizable.
async function fetchEmailsFromDb(sinceDateOrId = null) {
  const conn = await getDbConnection();
  const table = process.env.DB_TABLE || 'threads';
  const colId = process.env.DB_COL_ID || 'id';
  const colSubject = process.env.DB_COL_SUBJECT || 'subject';
  const colBody = process.env.DB_COL_BODY || 'body';
  const colSender = process.env.DB_COL_SENDER || 'sender';
  const colDate = process.env.DB_COL_DATE || 'date';

  let query = `
    SELECT ${colId} as id, thread_id, ${colSubject} as subject, 
           ${colBody} as body, 
           ${colSender} as sender, 
           ${colDate} as date, 
           ai_summary, 
           ocr_text 
    FROM \`${table}\`
    WHERE ${colSender} NOT LIKE '%protulchatterjee2020@gmail.com%'
      AND ${colSender} NOT LIKE '%biswajit@omclearing.com%'
      AND ${colSender} NOT LIKE '%automation@app.smartsheet.com%'
  `;

  const queryParams = [];
  if (sinceDateOrId) {
    if (sinceDateOrId instanceof Date) {
      query += ` AND ${colDate} >= ?`;
      queryParams.push(sinceDateOrId);
    } else {
      query += ` AND ${colId} > ?`;
      queryParams.push(Number(sinceDateOrId));
    }
  }

  query += ` ORDER BY ${colId} DESC`;

  const [rows] = await conn.execute(query, queryParams);
  await conn.end();
  return rows;
}

// ----------------------------------------------------
// Email Summarization (OpenAI or Fallback)
// ----------------------------------------------------

function getOcrSnippet(ocrText) {
  if (!ocrText) return '';
  const cleanOcr = ocrText.trim();
  if (cleanOcr.length <= 3000) return cleanOcr;

  const partLength = 1000;
  const firstPart = cleanOcr.substring(0, partLength);

  const middleStart = Math.floor((cleanOcr.length - partLength) / 2);
  const middlePart = cleanOcr.substring(middleStart, middleStart + partLength);

  const lastPart = cleanOcr.substring(cleanOcr.length - partLength);

  return `${firstPart}\n\n[... OCR MIDDLE SECTION ...]\n\n${middlePart}\n\n[... OCR END SECTION ...]\n\n${lastPart}`;
}

function getRuleBasedSummary(subject, body, ocrText = '') {
  const cleanBody = (body || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const summaryText = cleanBody.length > 250 ? cleanBody.substring(0, 250) + '...' : cleanBody;

  // Simple date detector
  const dateRegex = /\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})|(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/gi;
  const dates = [];
  let m;
  while ((m = dateRegex.exec(body || '')) !== null) {
    dates.push(m[0]);
  }

  const ocrSnippet = getOcrSnippet(ocrText);
  const ocrNote = ocrSnippet ? '\nAttachment OCR processed.' : '';

  const datesStr = dates.length > 0 ? `Potential dates: ${Array.from(new Set(dates)).join(', ')}` : 'No specific dates detected.';
  return `${summaryText}${ocrNote}\n\n(${datesStr})`;
}

async function getEmailSummary(subject, body, ocrText) {
  const ocrSnippet = getOcrSnippet(ocrText);
  const { client, model, error } = getAiClient();

  if (error || !client) {
    return getRuleBasedSummary(subject, body, ocrText);
  }

  try {
    const cleanBody = (body || '').replace(/<[^>]*>/g, '').substring(0, 4000);
    
    let prompt = `Please summarize the following tender email. Write a concise 2-to-3 sentence summary covering:
                  1) What actions/replies are required from us
                  2) Important dates or deadlines
                  3) Key context of the email

                  Email Subject: ${subject}
                  Email Content:
                  ${cleanBody}`;

    if (ocrSnippet) {
      prompt += `\n\nAdditionally, here is an OCR text snippet extracted from email attachments (first, middle, and last portions):\n${ocrSnippet}`;
    }

    const completion = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that summarizes email content concisely.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 250,
      temperature: 0.2
    });

    lastAiError = null;
    const textResponse = completion?.choices?.[0]?.message?.content;
    return textResponse ? textResponse.trim() : getRuleBasedSummary(subject, body, ocrText);
  } catch (error) {
    console.error(`AI summary failed:`, error.message);
    lastAiError = error.message; // Cache error to display in configuration panel
    return getRuleBasedSummary(subject, body, ocrText);
  }
}

// Get the body content of the latest message in a concatenated thread body.
function getLastMailContent(body) {
  if (!body) return '';
  
  const msgFromRegex = /--- Message\s+(\d+)\s+From:\s*(.*?)\s*---/i;
  const fwdHeaderRegex = /---------- Forwarded message ---------/i;
  const fromHeaderRegex = /(?:\r?\n|^)\*?\s*From\s*\*?\s*:/i;
  
  let firstIndex = body.length;
  
  const m1 = body.match(msgFromRegex);
  if (m1 && m1.index < firstIndex) firstIndex = m1.index;
  
  const m2 = body.match(fwdHeaderRegex);
  if (m2 && m2.index < firstIndex) firstIndex = m2.index;
  
  const m3 = body.match(fromHeaderRegex);
  if (m3 && m3.index < firstIndex) firstIndex = m3.index;
  
  return body.substring(0, firstIndex).trim();
}

// Extract a single deadline date from email content. Uses OpenAI when available, falls back to regex heuristics.
// Slices the thread to scan the last/latest message only. Discards deadlines that are prior to the email received date.
async function extractDeadlineDate(subject, body, ocrText, aiSummary = '', receivedDate = null) {
  const { client, model, error } = getAiClient();
  
  // Extract the latest/last message body only
  const lastMailBody = getLastMailContent(body);
  const cleanBody = (lastMailBody || '').replace(/<[^>]*>/g, '');
  
  // Take up to 5000 characters of OCR text to catch attachment deadlines
  const slicedOcr = ocrText ? String(ocrText).substring(0, 5000) : '';
  
  const combined = `AI Summary of Email:\n${aiSummary || ''}\n\nEmail Subject: ${subject || ''}\n\nEmail Body:\n${cleanBody}\n\nOCR Text (first 5000 chars):\n${slicedOcr}`;

  let extractedDate = null;

  // Try AI first (returns YYYY-MM-DD or empty string)
  if (client && !error) {
    try {
      const prompt = `Extract only the submission deadline date (if present) from the email details below. Focus on the submission deadline, closing date, or last date of submission mentioned in the summary, email content, or OCR text. Return a single date in ISO format YYYY-MM-DD and nothing else. If no submission deadline is present, return an empty string.\n\nEmail Details:\n${combined}`;

      const completion = await client.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: 'You MUST respond with either an ISO date like 2026-05-30 or an empty string. No extra text.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 20,
        temperature: 0
      });

      const content = completion?.choices?.[0]?.message?.content?.trim() || '';
      const iso = content.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) {
        extractedDate = iso[0];
      }
    } catch (err) {
      console.error('AI deadline extraction failed:', err.message);
    }
  }

  // Fallback regex extraction if AI didn't find one or is not configured
  if (!extractedDate) {
    const text = combined;
    const dateRegex = /\b(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi;
    const matches = [];
    let m;
    while ((m = dateRegex.exec(text)) !== null) {
      matches.push({ text: m[0], index: m.index });
    }

    if (matches.length > 0) {
      // Prefer dates near deadline-like keywords
      const keywords = ['last date', 'last date of submission', 'deadline', 'due by', 'submit by', 'submission by', 'closing date', 'last date for submission', 'last date to submit', 'last date:'];
      const lower = text.toLowerCase();
      const keywordPositions = keywords.map(k => lower.indexOf(k)).filter(p => p >= 0);

      let chosen = matches[0];
      if (keywordPositions.length > 0) {
        let best = null;
        let bestDist = Infinity;
        for (const d of matches) {
          for (const kp of keywordPositions) {
            const dist = Math.abs(d.index - kp);
            if (dist < bestDist) {
              bestDist = dist;
              best = d;
            }
          }
        }
        if (best) chosen = best;
      }

      // Normalize chosen date text to ISO YYYY-MM-DD
      function parseToISO(dateStr) {
        const norm = dateStr.replace(/[,]|st|nd|rd|th/gi, '').trim();
        // Try Date.parse first (handles '12 Jan 2026' and 'January 12, 2026')
        const parsed = Date.parse(norm);
        if (!isNaN(parsed)) {
          const d = new Date(parsed);
          return d.toISOString().slice(0, 10);
        }
        // Try dd/mm/yyyy or dd-mm-yyyy
        const dmy = norm.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
        if (dmy) {
          let day = Number(dmy[1]);
          let month = Number(dmy[2]);
          let year = Number(dmy[3]);
          if (year < 100) year += 2000;
          const dt = new Date(year, month - 1, day);
          if (!isNaN(dt)) return dt.toISOString().slice(0, 10);
        }
        return null;
      }

      extractedDate = parseToISO(chosen.text);
    }
  }

  // Date comparison validation:
  // If the extracted deadline date is prior to the email received date, discard it and return 'discarded'!
  if (extractedDate && receivedDate) {
    try {
      const emailDt = new Date(receivedDate);
      const deadlineDt = new Date(extractedDate);
      
      // Normalize to midnight to compare date components only
      emailDt.setHours(0, 0, 0, 0);
      deadlineDt.setHours(0, 0, 0, 0);
      
      if (deadlineDt < emailDt) {
        console.log(`[Deadline] Discarding past/expired deadline ${extractedDate} because it is prior to email received date ${receivedDate}`);
        return 'discarded';
      }
    } catch (e) {
      console.error('Error comparing deadline date with email received date:', e.message);
    }
  }

  return extractedDate;
}

// Rule-based tender status decider based on email subject/body keywords
function getRuleBasedTenderStatus(subject, body, summary = '') {
  const text = `${subject} ${body} ${summary}`.toLowerCase();
  
  if (text.includes('award') || text.includes('loi') || text.includes('loa') || text.includes('po ') || text.includes('purchase order') || text.includes('contract booking') || text.includes('dispatch instruction') || text.includes('dispatch intimation')) {
    return 'Tender Awarded';
  }
  if (text.includes('cancel') || text.includes('retender') || text.includes('re-tender')) {
    return 'Tender Cancelled';
  }
  if (text.includes('reverse auction') || text.includes('ra alert') || text.includes('ra scheduled')) {
    return 'Reverse Auction';
  }
  if (text.includes('financial opening') || text.includes('price bid') || text.includes(' l1 ')) {
    return 'Financial Opened';
  }
  if (text.includes('technical opening') || text.includes('bid opening') || text.includes('opened')) {
    return 'Bid Opened';
  }
  if (text.includes('clarification') || text.includes('query') || text.includes('queries') || 
      text.includes('pre-bid') || text.includes('technical deviation') || text.includes('reply') || 
      text.includes('response') || text.includes('deviation') || text.includes('shortfall') || 
      text.includes('submit') || text.includes('provide') || text.includes('missing') || 
      text.includes('urgent') || text.includes('attention') || text.includes('confirm receipt') || 
      text.includes('please confirm') || text.includes('send us')) {
    return 'Clarification Required';
  }
  if (text.includes('emd') || text.includes('bg ') || text.includes('tender fee') || text.includes('earnest money') || text.includes('bank guarantee')) {
    return 'EMD/BG Status';
  }
  if (text.includes('confirm') || text.includes('confirming') || text.includes('submit') || text.includes('submission confirmation') || text.includes('successfully uploaded')) {
    return 'Bid Submitted';
  }
  if (text.includes('corrigendum') || text.includes('extension') || text.includes('extended')) {
    return 'Corrigendum Issued';
  }
  return 'Active';
}

function getRuleBasedReplyDecision(subject, body, summary = '') {
  const text = `${subject || ''} ${body || ''} ${summary || ''}`.toLowerCase();
  const positiveSignals = [
    'urgent', 'asap', 'immediate', 'immediately', 'reply', 'respond', 'response required',
    'please confirm', 'confirm receipt', 'clarification', 'query', 'queries', 'shortfall',
    'missing', 'provide', 'submit', 'send us', 'requested to', 'kindly confirm',
    'action required', 'need your confirmation', 'technical deviation', 'commercial deviation'
  ];
  const negativeSignals = [
    'no reply required', 'do not reply', 'for your information', 'fyi', 'acknowledged', 'acknowledgement',
    'successfully uploaded', 'bid submitted', 'acknowledgement'
  ];

  if (negativeSignals.some(signal => text.includes(signal))) {
    return { required: false, reason: 'Latest email appears informational or already acknowledged.' };
  }

  if (positiveSignals.some(signal => text.includes(signal))) {
    return { required: true, reason: 'Latest email asks for confirmation, clarification, documents, or urgent response.' };
  }

  return { required: false, reason: 'No direct reply request detected in the latest email.' };
}

async function getReplyDecision(subject, body, summary = '') {
  const fallback = getRuleBasedReplyDecision(subject, body, summary);
  const { client, model, error } = getAiClient();
  if (error || !client) return fallback;

  try {
    const cleanBody = (body || '').replace(/<[^>]*>/g, '').substring(0, 2500);
    const prompt = `Decide if the latest tender-related email requires an urgent reply from Laser Power & Infra.
Return JSON only in this exact shape:
{"required":true_or_false,"reason":"short reason under 120 characters"}

Mark required true only when the sender is asking for a reply, confirmation, clarification, missing document, revised submission, or urgent action.

Subject: ${subject || ''}
Summary: ${summary || ''}
Email:
${cleanBody}`;

    const completion = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You classify procurement emails for urgent reply requirements. Respond with strict JSON only.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 80,
      temperature: 0
    });

    const content = completion?.choices?.[0]?.message?.content?.trim();
    if (!content) return fallback;
    const parsed = extractReplyDecisionFromJson(content);
    return {
      required: parsed && parsed.required !== null ? parsed.required : fallback.required,
      reason: parsed && parsed.reason ? parsed.reason.slice(0, 180) : fallback.reason
    };
  } catch (error) {
    console.error('AI reply decision failed:', error.message);
    return fallback;
  }
}

// AI-based tender status decider using OpenAI (or rule-based fallback)
async function getTenderStatus(subject, body, summary = '') {
  const { client, model, error } = getAiClient();
  if (error || !client) {
    return getRuleBasedTenderStatus(subject, body, summary);
  }

  try {
    const cleanBody = (body || '').replace(/<[^>]*>/g, '').substring(0, 2500);
    
    const prompt = `Based on the following tender email details, determine the current status of the tender in exactly 2 to 3 words.
Examples: "Bid Submitted", "Clarification Required", "EMD Approved", "Technical Bid Opened", "Financial Bid Opened", "Tender Awarded", "Tender Cancelled", "Queries Raised", "Active".

Email Subject: ${subject}
AI Summary: ${summary}
Email Content Snippet:
${cleanBody}

Respond ONLY with the status label (2-3 words).`;

    const completion = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are an expert procurement assistant. You respond with a short 2-3 word status label based on email updates.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 15,
      temperature: 0.1
    });

    const statusLabel = completion?.choices?.[0]?.message?.content;
    if (statusLabel) {
      return statusLabel.replace(/['".]/g, '').trim();
    }
    return getRuleBasedTenderStatus(subject, body, summary);
  } catch (error) {
    console.error('AI status decider failed:', error.message);
    return getRuleBasedTenderStatus(subject, body, summary);
  }
}

// ----------------------------------------------------
// Sheet Parsing Helper
// ----------------------------------------------------
function parseSheetRows(rows) {
  if (!rows || rows.length === 0) return [];
  const headers = rows[0].map(h => (h || '').trim().toLowerCase());
  
  const getIndex = (name) => {
    const normalizedName = name.toLowerCase().trim();
    return headers.findIndex(h => {
      const normalizedHeader = h.toLowerCase().trim();
      return normalizedHeader === normalizedName || normalizedHeader.includes(normalizedName) || normalizedName.includes(normalizedHeader);
    });
  };
  
  const idxSlNo = getIndex("SL No.");
  const idxDocket = getIndex("Docket No");
  const idxTenderFor = getIndex("Tender For");
  const idxType = getIndex("Type of Tender");
  const idxTenderNo = getIndex("Tender No / NIT No with Date");
  const idxNameWork = getIndex("Name of Work / Item Description?");
  const idxClient = getIndex("Name of the Client?");
  const idxLastDate = getIndex("Last Date of Submission");
  const idxOpeningDate = getIndex("Tender Opening Date");
  const idxCost = getIndex("Cost of Tender / Tender Fee (In Rs)");
  const idxEmd = getIndex("EMD Amount (In Rs)");
  const idxEstimatedCost = getIndex("Estimated Cost (In Rs)");
  const idxParticipated = headers.findIndex(h => h.includes('participated'));
  const idxStatus = getIndex("Current Status");
  const idxRemarks = getIndex("Remarks");
  const idxPrepareBy = getIndex("Tender Prepare By");

  const tenders = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0) continue;
    
    const getValue = (idx) => (idx !== -1 && idx < row.length) ? (row[idx] || '').trim() : '';
    
    const participatedValue = getValue(idxParticipated);
    const cleanParticipated = participatedValue.toLowerCase().trim();
    const isParticipated = cleanParticipated === 'yes' || cleanParticipated === 'y' || cleanParticipated === 'true' || cleanParticipated === '1' || cleanParticipated.includes('yes');

    tenders.push({
      slNo: getValue(idxSlNo),
      docketNo: getValue(idxDocket),
      tenderFor: getValue(idxTenderFor),
      type: getValue(idxType),
      tenderNoRaw: getValue(idxTenderNo),
      nameOfWork: getValue(idxNameWork),
      client: getValue(idxClient),
      lastDate: getValue(idxLastDate),
      openingDate: getValue(idxOpeningDate),
      cost: getValue(idxCost),
      emd: getValue(idxEmd),
      estimatedCost: getValue(idxEstimatedCost),
      participated: participatedValue,
      isParticipated: isParticipated,
      status: getValue(idxStatus),
      remarks: getValue(idxRemarks),
      prepareBy: getValue(idxPrepareBy),
      rowNumber: i + 1
    });
  }

  return tenders;
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Get Portal Status (check db and sheets authentication)
app.get('/api/status', async (req, res) => {
  const { client, model, provider, error } = getAiClient();

  const status = {
    sheetsAuth: false,
    database: false,
    dbFallbackActive: false,
    openaiKey: !error && !!client && !lastAiError,
    aiProvider: provider,
    aiModel: model,
    dbHost: process.env.DB_HOST || 'localhost',
    dbName: process.env.DB_NAME || 'defaultdb',
    dbTable: process.env.DB_TABLE || 'threads',
    sheetId: process.env.GOOGLE_SPREADSHEET_ID,
    sheetGid: process.env.GOOGLE_SHEET_GID,
    errors: {}
  };

  if (lastAiError) {
    status.errors.openai = lastAiError;
  }

  // Check sheets credentials
  const credentialsPath = path.join(__dirname, 'credentials.json');
  const tokenPath = path.join(__dirname, 'token.json');
  if (fs.existsSync(credentialsPath) && fs.existsSync(tokenPath)) {
    try {
      await getSheetsClient();
      status.sheetsAuth = true;
    } catch (err) {
      status.errors.sheets = err.message;
    }
  } else {
    status.errors.sheets = 'credentials.json or token.json is missing in the project root.';
  }

  // Check MySQL Database connection
  try {
    const conn = await getDbConnection();
    const table = process.env.DB_TABLE || 'threads';
    await conn.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
    await conn.end();
    status.database = true;
  } catch (err) {
    status.errors.database = err.message;
    status.dbFallbackActive = true;
  }

  res.json(status);
});

// 2. Fetch Sync Status / Cache details
app.get('/api/sync-info', async (req, res) => {
  const cache = readCache(CACHE_FILE, null);
  if (!cache) {
    return res.json({ synced: false, lastSynced: null, tendersCount: 0, matchesCount: 0 });
  }

  let matchesCount = 0;
  try {
    const conn = await getDbConnection();
    const [rows] = await conn.query('SELECT COUNT(*) as count FROM tender_matches');
    matchesCount = rows[0].count;
    await conn.end();
  } catch (err) {
    console.error('Error fetching matches count from database:', err.message);
  }

  res.json({
    synced: true,
    lastSynced: cache.lastSynced,
    tendersCount: cache.tenders.length,
    participatedCount: cache.tenders.filter(t => t.isParticipated).length,
    matchesCount: matchesCount
  });
});

// Global state to prevent concurrent sync executions
let isSyncing = false;

async function runSync() {
  if (isSyncing) {
    console.log('Sync is already in progress. Skipping...');
    throw new Error('Sync already in progress');
  }

  isSyncing = true;
  let conn;
  try {
    console.log('Syncing started...');
    
    // Read previous sync metadata to check for incremental execution
    const cache = readCache(CACHE_FILE, null);
    let lastSyncedId = null;
    let cachedTendersMap = {};

    if (cache && cache.lastSyncedId) {
      lastSyncedId = Number(cache.lastSyncedId);
    }
    if (cache && cache.tenders) {
      cache.tenders.forEach(t => {
        const key = `${t.docketNo}||${t.tenderNoRaw}`;
        cachedTendersMap[key] = true;
      });
    }

    // A. Fetch current sheet list
    const rawRows = await fetchGoogleSheetTenders();
    const tenders = parseSheetRows(rawRows);
    const participatedTenders = tenders.filter(t => t.isParticipated);

    // Save GSheet tenders cache immediately so the UI can load them while matching is in progress!
    const syncPayload = {
      lastSynced: new Date().toISOString(),
      lastSyncedId: lastSyncedId,
      tenders: tenders
    };
    writeCache(CACHE_FILE, syncPayload);

    // Identify if there are any new tenders added since the last sync
    const newTenders = participatedTenders.filter(t => {
      const key = `${t.docketNo}||${t.tenderNoRaw}`;
      return !cachedTendersMap[key];
    });
    const hasNewTenders = newTenders.length > 0;

    // B. Fetch threads (lightweight query)
    // Incremental: If no new tenders, only fetch threads from the last 7 days (1 week).
    // If there are new tenders or FORCE_FULL_SYNC is enabled, we must scan all threads!
    let threads = [];
    const forceFullSync = process.env.FORCE_FULL_SYNC === 'true' || process.env.FORCE_FULL_SYNC === '1';
    if (lastSyncedId && !hasNewTenders && !forceFullSync) {
  console.log(`Incremental sync: fetching emails with id > ${lastSyncedId}`);
  threads = await fetchEmailsFromDb(lastSyncedId);
} else {
  if (forceFullSync) {
    console.log(`Full sync mode enabled: Scanning ALL threads`);
  } else {
    console.log(`Full candidate sync: Scanning all threads`);
  }

  threads = await fetchEmailsFromDb();
}

    console.log(`Pre-normalizing ${threads.length} threads for fast CPU matching (non-blocking)...`);
    const { normalizeText } = require('./matcher');
    const normalizedThreads = [];
    const normChunkSize = 100;
    for (let i = 0; i < threads.length; i += normChunkSize) {
      const chunk = threads.slice(i, i + normChunkSize);
      for (const t of chunk) {
        normalizedThreads.push({
          ...t,
          normSubject: normalizeText(t.subject),
          normBody: normalizeText(t.body),
          normOcr: normalizeText(t.ocr_text)
        });
      }
      // Yield to the event loop to keep server responsive
      await new Promise(resolve => setImmediate(resolve));
    }

    // Pre-compile token regexes for all participated tenders
    console.log(`Pre-compiling token regexes for ${participatedTenders.length} participated tenders...`);
    participatedTenders.forEach(tender => {
      const tokens = extractTenderTokens(tender.tenderNoRaw);
      tender.tokens = tokens;
      tender.compiledRegexes = tokens.map(token => ({
        token: token,
        regex: makeTokenRegex(token)
      }));
    });
    console.log(`Pre-compilation complete. Starting matching engine (non-blocking)...`);

    const table = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colBody = process.env.DB_COL_BODY || 'body';

    const matchesToInsert = [];

    // C. Matching loop (CPU intensive, non-blocking chunked execution)
    for (let i = 0; i < participatedTenders.length; i++) {
      const tender = participatedTenders[i];
      if (!tender.docketNo) continue;
      
      const key = `${tender.docketNo}||${tender.tenderNoRaw}`;
      const isNewTender = !cachedTendersMap[key];

      for (const thread of normalizedThreads) {
        // Skip matching any thread from blacklisted senders
        const senderLower = (thread.sender || '').toLowerCase();
        if (senderLower.includes('protulchatterjee2020@gmail.com') || senderLower.includes('biswajit@omclearing.com')) {
          continue;
        }

        const matchResult = checkMatchCompiled(tender.compiledRegexes, thread.normSubject, thread.normBody, thread.normOcr);
        if (matchResult.matched) {
          matchesToInsert.push({
            docketNo: tender.docketNo,
            tenderNo: tender.tenderNoRaw,
            threadDbId: thread.id,
            threadId: thread.thread_id,
            matchedToken: matchResult.matchedToken,
            confidence: matchResult.confidence,
            thread: thread
          });
        }
      }

      // Yield to the event loop every 5 tenders to allow HTTP requests to be handled
      if (i % 5 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    let newMatchesCount = 0;

    // D. Database batch insert & summary updates
    if (matchesToInsert.length > 0) {
      console.log(`Found ${matchesToInsert.length} matching emails. Inserting into database...`);
      conn = await getDbConnection();
      
      for (const match of matchesToInsert) {
        const thread = match.thread;

        // Fetch full text & generate summary only if not already summarized
        if (!thread.ai_summary || thread.ai_summary.trim() === '') {
          console.log(`Summarizing matched email ${thread.id} on demand...`);
          
          const [fullRows] = await conn.execute(`
            SELECT ${colBody} as body, ocr_text 
            FROM \`${table}\` 
            WHERE ${colId} = ?
          `, [thread.id]);
          
          const fullThread = fullRows[0] || { body: thread.body, ocr_text: thread.ocr_text };
          const summary = await getEmailSummary(thread.subject, fullThread.body, fullThread.ocr_text);
          
          await conn.execute(`
            UPDATE \`${table}\` 
            SET ai_summary = ? 
            WHERE ${colId} = ?
          `, [summary, thread.id]);
          thread.ai_summary = summary;
          thread.body = fullThread.body; // Populate body for status decider
        }

        // Determine tender status and reply requirement based on the matching email details
        const tenderStatusVal = await getTenderStatus(thread.subject, thread.body, thread.ai_summary);
        const replyDecision = await getReplyDecision(thread.subject, thread.body, thread.ai_summary);

        // Extract deadline date (AI first, then regex) from the last email only.
        let deadline_date_val = null;
        let isDiscarded = false;
        try {
          const extracted = await extractDeadlineDate(thread.subject, thread.body, thread.ocr_text, thread.ai_summary, thread.date);
          if (extracted === 'discarded') {
            isDiscarded = true;
            deadline_date_val = null;
          } else if (extracted) {
            // Normalize to MySQL DATETIME (YYYY-MM-DD HH:MM:SS)
            const dt = new Date(extracted);
            if (!isNaN(dt.getTime())) {
              deadline_date_val = dt.toISOString().slice(0,19).replace('T', ' ');
            } else {
              deadline_date_val = null;
            }
          }
        } catch (ex) {
          console.error('Deadline extraction failed:', ex.message || ex);
        }

        // Fall back to the email date if a reply is required and no valid future deadline was found (even if it was discarded/past)
        if ((!deadline_date_val || isDiscarded) && replyDecision.required) {
          try {
            const recv = thread.date ? new Date(thread.date) : new Date();
            deadline_date_val = recv.toISOString().slice(0,19).replace('T', ' ');
            isDiscarded = false; // We have a valid fallback deadline now
          } catch (e) {
            deadline_date_val = null;
          }
        }

        const final_save_deadline = (isDiscarded && !deadline_date_val) ? '1970-01-01 00:00:00' : deadline_date_val;

        // Log match relationship in SQL
        const insertMatchQuery = `
          INSERT IGNORE INTO tender_matches 
          (docket_no, tender_no, thread_db_id, thread_id, matched_token, confidence, tender_status, reply_required, reply_reason, deadline_date) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await conn.execute(insertMatchQuery, [
          match.docketNo,
          match.tenderNo,
          match.threadDbId,
          match.threadId,
          match.matchedToken,
          match.confidence,
          tenderStatusVal,
          replyDecision.required ? 1 : 0,
          replyDecision.reason,
          final_save_deadline
        ]);
        
        if (result.affectedRows > 0) {
          newMatchesCount++;
        }
      }
    }

    // Determine the max thread ID seen in this sync to store as the new threshold
    let newMaxSyncedId = lastSyncedId || 0;
    if (threads.length > 0) {
      const maxFetchedId = Math.max(...threads.map(t => Number(t.id)));
      if (maxFetchedId > newMaxSyncedId) {
        newMaxSyncedId = maxFetchedId;
      }
    }

    // Save final GSheet tenders cache to mark lastSynced timestamp & lastSyncedId
    const finalSyncPayload = {
      lastSynced: new Date().toISOString(),
      lastSyncedId: newMaxSyncedId,
      tenders: tenders
    };
    writeCache(CACHE_FILE, finalSyncPayload);
    
    console.log(`Sync completed successfully. Matches found: ${newMatchesCount}. New threshold ID: ${newMaxSyncedId}`);
    return {
      success: true,
      lastSynced: finalSyncPayload.lastSynced,
      lastSyncedId: newMaxSyncedId,
      totalTenders: tenders.length,
      participatedTenders: participatedTenders.length,
      matchedEmailsCount: newMatchesCount
    };
  } catch (error) {
    console.error('Sync failed:', error);
    throw error;
  } finally {
    isSyncing = false;
    if (conn) {
      await conn.end();
    }
  }
}

// 3. Trigger Syncing route (delegates to runSync)
app.get('/api/sync', async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// 4. Get All Tenders (from cache, merged with database match counts & latest activity date)
app.get('/api/tenders', async (req, res) => {
  const cache = readCache(CACHE_FILE, null);
  if (!cache) {
    return res.status(404).json({ error: 'No data synced yet. Please trigger sync.' });
  }

  const { excludeTenderTiger } = req.query;
  const isExclude = excludeTenderTiger === 'true';

  let countsMap = {};
  let conn;
  try {
    conn = await getDbConnection();
    
    // Join matches table with threads to fetch the date of the latest email matched
    let query = `
      SELECT tm.docket_no, tm.tender_no, COUNT(*) as match_count,
             MAX(t.date) as latest_email_date,
             MAX(CASE WHEN tm.confidence = 'HIGH' THEN 2 WHEN tm.confidence = 'MEDIUM' THEN 1 ELSE 0 END) as max_conf_val,
             GROUP_CONCAT(DISTINCT t.sender SEPARATOR '||') as senders
      FROM tender_matches tm
      JOIN threads t ON tm.thread_db_id = t.id
      WHERE t.sender NOT LIKE '%protulchatterjee2020@gmail.com%'
        AND t.sender NOT LIKE '%biswajit@omclearing.com%'
    `;
    const params = [];
    if (isExclude) {
      query += ` AND t.sender NOT LIKE ? `;
      params.push('%tendertiger.com%');
    }
    query += ` GROUP BY tm.docket_no, tm.tender_no `;

    const [rows] = await conn.execute(query, params);
    
    rows.forEach(r => {
      const key = `${r.docket_no}||${r.tender_no}`;
      countsMap[key] = {
        count: r.match_count,
        latestEmailDate: r.latest_email_date,
        maxConfidence: r.max_conf_val === 2 ? 'HIGH' : (r.max_conf_val === 1 ? 'MEDIUM' : 'NONE'),
        status: null,
        replyRequired: false,
        replyReason: null,
        latestEmailId: null,
        deadlineDate: null,
        senders: r.senders ? r.senders.split('||') : []
      };
    });
    // Fetch latest matched email details for each tender to resolve status, including matched_at to detect updates
    let statusQuery = `
      SELECT tm.docket_no, tm.tender_no, tm.tender_status, tm.reply_required, tm.reply_reason,
             tm.deadline_date, tm.matched_at,
             t.id as thread_id, t.subject, t.body, t.ai_summary, t.ocr_text, t.date
      FROM tender_matches tm
      JOIN threads t ON tm.thread_db_id = t.id
      WHERE t.sender NOT LIKE '%protulchatterjee2020@gmail.com%'
        AND t.sender NOT LIKE '%biswajit@omclearing.com%'
        ${isExclude ? "AND t.sender NOT LIKE '%tendertiger.com%'" : ""}
        AND (tm.docket_no, tm.tender_no, t.date) IN (
            SELECT tm2.docket_no, tm2.tender_no, MAX(t2.date)
            FROM tender_matches tm2
            JOIN threads t2 ON tm2.thread_db_id = t2.id
            WHERE t2.sender NOT LIKE '%protulchatterjee2020@gmail.com%'
              AND t2.sender NOT LIKE '%biswajit@omclearing.com%'
              ${isExclude ? "AND t2.sender NOT LIKE '%tendertiger.com%'" : ""}
            GROUP BY tm2.docket_no, tm2.tender_no
        )
    `;
    
    const [statusRows] = await conn.execute(statusQuery);
    
    for (const r of statusRows) {
      const key = `${r.docket_no}||${r.tender_no}`;
      if (countsMap[key]) {
        // Detect if a new email has arrived in the thread since the match was originally made
        const emailDate = r.date ? new Date(r.date) : null;
        const matchedAtDate = r.matched_at ? new Date(r.matched_at) : null;
        const hasNewEmail = emailDate && matchedAtDate && (emailDate > matchedAtDate);

        let tenderStatus = r.tender_status;
        if (!tenderStatus || hasNewEmail) {
          tenderStatus = getRuleBasedTenderStatus(r.subject, r.body, r.ai_summary);
          // Save status back to DB asynchronously
          conn.execute(
            "UPDATE tender_matches SET tender_status = ?, matched_at = CURRENT_TIMESTAMP WHERE thread_db_id = ? AND docket_no = ? AND tender_no = ?",
            [tenderStatus, r.thread_id, r.docket_no, r.tender_no]
          ).catch(dbErr => console.error("Background status update failed:", dbErr.message));
        }
        let replyRequired = Boolean(r.reply_required);
        let replyReason = r.reply_reason;
        if (!replyReason || hasNewEmail) {
          const replyDecision = await getReplyDecision(r.subject, r.body, r.ai_summary);
          replyRequired = replyDecision.required;
          replyReason = replyDecision.reason;
          conn.execute(
            "UPDATE tender_matches SET reply_required = ?, reply_reason = ?, matched_at = CURRENT_TIMESTAMP WHERE thread_db_id = ? AND docket_no = ? AND tender_no = ?",
            [replyRequired ? 1 : 0, replyReason, r.thread_id, r.docket_no, r.tender_no]
          ).catch(dbErr => console.error("Background reply decision update failed:", dbErr.message));
        }

        let deadlineDate = r.deadline_date;
        const isSentinel = deadlineDate && (String(deadlineDate).startsWith('1970-01-01') || String(deadlineDate).startsWith('1969-12-31'));
        
        if (!deadlineDate || isSentinel || hasNewEmail) {
          try {
            let isDiscarded = false;
            // Only extract if it is a new email or not yet processed (not already marked as sentinel)
            if (!deadlineDate || hasNewEmail) {
              const extracted = await extractDeadlineDate(r.subject, r.body, r.ocr_text, r.ai_summary, r.date);
              if (extracted === 'discarded') {
                isDiscarded = true;
                deadlineDate = null;
              } else if (extracted) {
                const dt = new Date(extracted);
                if (!isNaN(dt.getTime())) {
                  deadlineDate = dt.toISOString().slice(0,19).replace('T', ' ');
                } else {
                  deadlineDate = null;
                }
              }
            } else {
              // It was already a sentinel, meaning no valid deadline was found in the previous run
              isDiscarded = true;
              deadlineDate = null;
            }
            
            // Fall back to the email date if a reply is required and no valid future deadline was found (even if it was discarded/past)
            if ((!deadlineDate || isDiscarded) && replyRequired) {
              const recv = r.date ? new Date(r.date) : new Date();
              deadlineDate = recv.toISOString().slice(0,19).replace('T', ' ');
              isDiscarded = false; // We have a valid fallback deadline now, so we don't save the sentinel!
            }
            
            // Save back to DB if changed or new
            if (deadlineDate !== r.deadline_date || isDiscarded) {
              const saveVal = isDiscarded ? '1970-01-01 00:00:00' : deadlineDate;
              conn.execute(
                "UPDATE tender_matches SET deadline_date = ?, matched_at = CURRENT_TIMESTAMP WHERE thread_db_id = ? AND docket_no = ? AND tender_no = ?",
                [saveVal, r.thread_id, r.docket_no, r.tender_no]
              ).catch(dbErr => console.error("Background deadline update failed:", dbErr.message));
            }
          } catch (ex) {
            console.error('Deadline extraction failed:', ex.message || ex);
          }
        }

        countsMap[key].status = tenderStatus;
        countsMap[key].replyRequired = replyRequired;
        countsMap[key].replyReason = replyReason;
        countsMap[key].latestEmailId = r.thread_id;
        countsMap[key].deadlineDate = deadlineDate;
      }
    }

  } catch (err) {
    console.error('Error fetching database match counts:', err.message);
  } finally {
    if (conn) {
      await conn.end();
    }
  }
  
  // Enhance tenders with match counts & latest activity date from DB
  const validTenders = (cache.tenders || []).filter(t => t.docketNo || t.tenderNoRaw);
  const tendersWithMatches = validTenders.map(t => {
    const key = `${t.docketNo}||${t.tenderNoRaw}`;
    const dbMatch = countsMap[key] || { count: 0, latestEmailDate: null, maxConfidence: 'NONE', status: null, replyRequired: false, replyReason: null, latestEmailId: null, deadlineDate: null, senders: [] };
    
    if (t.isParticipated && !t.tokens) {
      t.tokens = extractTenderTokens(t.tenderNoRaw);
    }

    return {
      ...t,
      matchCount: dbMatch.count,
      latestEmailDate: dbMatch.latestEmailDate,
      maxConfidence: dbMatch.maxConfidence,
      status: dbMatch.count > 0 ? (dbMatch.status || t.status || 'Active') : (t.status || 'Active'),
      replyRequired: dbMatch.replyRequired,
      replyReason: dbMatch.replyReason,
      latestEmailId: dbMatch.latestEmailId,
      deadlineDate: dbMatch.deadlineDate,
      senders: dbMatch.senders || []
    };
  });

  // Sort tenders:
  // 1. Participated tenders first.
  // 2. Tenders with matches first.
  // 3. For tenders with matches, sort by latest matched email date (newest first).
  // 4. For tenders without matches, sort by sheet row index descending (newest sheet row first).
  tendersWithMatches.sort((a, b) => {
    if (a.isParticipated !== b.isParticipated) {
      return a.isParticipated ? -1 : 1;
    }
    
    if (a.isParticipated) {
      // Both are participated
      if (a.matchCount > 0 && b.matchCount === 0) return -1;
      if (a.matchCount === 0 && b.matchCount > 0) return 1;

      if (a.matchCount > 0 && b.matchCount > 0) {
        if (a.latestEmailDate && b.latestEmailDate) {
          return new Date(b.latestEmailDate) - new Date(a.latestEmailDate);
        }
      }
    }
    
    return b.rowNumber - a.rowNumber;
  });

  res.json(tendersWithMatches);
});

// 5. Get Matched Emails (Threads) for a Specific Tender GSheet Row
app.get('/api/tenders/:rowNumber/emails', async (req, res) => {
  const cache = readCache(CACHE_FILE, null);
  if (!cache) {
    return res.status(404).json({ error: 'No data synced yet.' });
  }

  const { excludeTenderTiger } = req.query;
  const isExclude = excludeTenderTiger === 'true';

  const rowNumber = Number(req.params.rowNumber);
  const tender = cache.tenders.find(t => t.rowNumber === rowNumber);
  if (!tender) {
    return res.status(404).json({ error: 'Tender row not found.' });
  }

  if (!tender.docketNo) {
    return res.json([]); 
  }

  let conn;
  try {
    conn = await getDbConnection();
    const threadsTable = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';
    const colSender = process.env.DB_COL_SENDER || 'sender';
    const colDate = process.env.DB_COL_DATE || 'date';

    // Query matched emails by joining threads table with tender_matches
    let query = `
      SELECT t.${colId} as id, t.thread_id, t.${colSubject} as subject, t.${colBody} as body,
             t.${colSender} as sender, t.${colDate} as date_received, t.ai_summary as summary,
             LEFT(t.ocr_text, 7000) as ocr_text, t.attach_names, t.attach_links,
             tm.matched_token, tm.matched_token as matchedToken, tm.confidence
      FROM \`${threadsTable}\` t
      JOIN tender_matches tm ON t.${colId} = tm.thread_db_id
      WHERE tm.docket_no = ? AND tm.tender_no = ?
        AND t.sender NOT LIKE '%protulchatterjee2020@gmail.com%'
        AND t.sender NOT LIKE '%biswajit@omclearing.com%'
        AND t.sender NOT LIKE '%automation@app.smartsheet.com%'
    `;
    const params = [tender.docketNo, tender.tenderNoRaw];

    if (isExclude) {
      query += ` AND t.sender NOT LIKE ? `;
      params.push('%tendertiger.com%');
    }

    query += ` ORDER BY t.${colDate} DESC `;

    console.log(`[API] Row ${rowNumber} -> Docket: "${tender.docketNo}", TenderNo: "${tender.tenderNoRaw}"`);
    console.log(`[API] Query: ${query.trim()}`);
    const [emails] = await conn.execute(query, params);
    console.log(`[API] Query returned ${emails.length} emails.`);
    
    // Add processed ocr_snippet for details pane
    const formattedEmails = emails.map(email => ({
      ...email,
      ocr_snippet: getOcrSnippet(email.ocr_text)
    }));

    res.json(formattedEmails);
  } catch (err) {
    console.error('Failed to load database matches for tender:', err.message);
    res.status(500).json({ error: 'Failed to load matched emails', details: err.message });
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});

// 6. Force Regenerate summary for an email and save to threads table
// Additionally re-evaluates tender status, reply decision, and deadline if the email is matched to a tender.
app.post('/api/emails/:id/summarize', async (req, res) => {
  const emailId = req.params.id;
  let conn;
  try {
    conn = await getDbConnection();
    const threadsTable = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';

    // Retrieve email body, subject, ocr_text, and date from threads table
    const [rows] = await conn.execute(`SELECT ${colSubject} as subject, ${colBody} as body, ocr_text, date FROM \`${threadsTable}\` WHERE ${colId} = ?`, [emailId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Email thread not found in database.' });
    }

    const email = rows[0];
    console.log(`Manually generating summary for email thread ${emailId} with OCR text...`);
    const summary = await getEmailSummary(email.subject, email.body, email.ocr_text);

    // Save summary directly into threads table
    await conn.execute(`UPDATE \`${threadsTable}\` SET ai_summary = ? WHERE ${colId} = ?`, [summary, emailId]);

    // Check if this email is matched in tender_matches and re-evaluate AI details
    const [matchRows] = await conn.execute(`SELECT id, docket_no, tender_no FROM tender_matches WHERE thread_db_id = ?`, [emailId]);
    if (matchRows.length > 0) {
      console.log(`Email thread ${emailId} is matched to a tender. Re-evaluating status, reply decision, and deadline...`);
      
      const tenderStatusVal = await getTenderStatus(email.subject, email.body, summary);
      const replyDecision = await getReplyDecision(email.subject, email.body, summary);
      
      let deadline_date_val = null;
      let isDiscarded = false;
      try {
        const extracted = await extractDeadlineDate(email.subject, email.body, email.ocr_text, summary, email.date);
        if (extracted === 'discarded') {
          isDiscarded = true;
          deadline_date_val = null;
        } else if (extracted) {
          const dt = new Date(extracted);
          if (!isNaN(dt.getTime())) {
            deadline_date_val = dt.toISOString().slice(0,19).replace('T', ' ');
          }
        }
      } catch (ex) {
        console.error('Manual deadline extraction failed:', ex.message || ex);
      }

      // Fallback if reply is required and no valid future deadline
      if ((!deadline_date_val || isDiscarded) && replyDecision.required) {
        try {
          const recv = email.date ? new Date(email.date) : new Date();
          deadline_date_val = recv.toISOString().slice(0,19).replace('T', ' ');
          isDiscarded = false;
        } catch (e) {
          deadline_date_val = null;
        }
      }

      const final_save_deadline = (isDiscarded && !deadline_date_val) ? '1970-01-01 00:00:00' : deadline_date_val;

      // Update tender_matches table
      await conn.execute(`
        UPDATE tender_matches 
        SET tender_status = ?, reply_required = ?, reply_reason = ?, deadline_date = ?, matched_at = CURRENT_TIMESTAMP
        WHERE thread_db_id = ?
      `, [tenderStatusVal, replyDecision.required ? 1 : 0, replyDecision.reason, final_save_deadline, emailId]);
      
      console.log(`Updated tender_matches for email thread ${emailId}: status='${tenderStatusVal}', reply_required=${replyDecision.required}, deadline='${final_save_deadline}'`);
    }

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Manual summarization failed:', error);
    res.status(500).json({ error: 'Summarization failed', details: error.message });
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});

// 7. Get Recent Matched Emails (across all tenders) for notifications and dashboard activity
app.get('/api/recent-matches', async (req, res) => {
  const { excludeTenderTiger } = req.query;
  const isExclude = excludeTenderTiger === 'true';

  let conn;
  try {
    conn = await getDbConnection();
    const threadsTable = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colSender = process.env.DB_COL_SENDER || 'sender';
    const colDate = process.env.DB_COL_DATE || 'date';
    
    let query = `
      SELECT t.${colId} as id, t.thread_id, t.${colSubject} as subject, t.${colSender} as sender, t.${colDate} as date_received, t.ai_summary as summary,
             LEFT(t.ocr_text, 3000) as ocr_text, tm.docket_no, tm.tender_no, tm.matched_token, tm.matched_token as matchedToken, tm.confidence
      FROM \`${threadsTable}\` t
      JOIN tender_matches tm ON t.${colId} = tm.thread_db_id
      WHERE t.sender NOT LIKE '%protulchatterjee2020@gmail.com%'
        AND t.sender NOT LIKE '%biswajit@omclearing.com%'
        AND t.sender NOT LIKE '%automation@app.smartsheet.com%'
    `;
    const params = [];
    if (isExclude) {
      query += ` AND t.sender NOT LIKE ? `;
      params.push('%tendertiger.com%');
    }

    query += ` ORDER BY t.${colDate} DESC LIMIT 10 `;

    const [emails] = await conn.execute(query, params);
    
    // Add formatted ocr snippet
    const formattedEmails = emails.map(e => ({
      ...e,
      ocr_snippet: getOcrSnippet(e.ocr_text)
    }));
    
    res.json(formattedEmails);
  } catch (err) {
    console.error('Failed to load recent matched emails:', err.message);
    res.status(500).json({ error: 'Failed to load recent matches', details: err.message });
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});

// 7b. Get Matched Emails with optional date range filters
app.get('/api/matched-emails', async (req, res) => {
  const { startDate, endDate, excludeTenderTiger } = req.query;
  const isExclude = excludeTenderTiger === 'true';

  let conn;
  try {
    conn = await getDbConnection();
    const threadsTable = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colSender = process.env.DB_COL_SENDER || 'sender';
    const colDate = process.env.DB_COL_DATE || 'date';
    const colBody = process.env.DB_COL_BODY || 'body';

    let query = `
      SELECT t.${colId} as id, t.thread_id, t.${colSubject} as subject, t.${colSender} as sender, t.${colDate} as date_received, t.ai_summary as summary,
             LEFT(t.ocr_text, 3000) as ocr_text, t.${colBody} as body, t.attach_names, t.attach_links, tm.docket_no, tm.tender_no, tm.matched_token, tm.matched_token as matchedToken, tm.confidence
      FROM \`${threadsTable}\` t
      JOIN tender_matches tm ON t.${colId} = tm.thread_db_id
    `;
    const params = [];
    const conditions = [
      "t.sender NOT LIKE '%protulchatterjee2020@gmail.com%'",
      "t.sender NOT LIKE '%biswajit@omclearing.com%'",
      "t.sender NOT LIKE '%automation@app.smartsheet.com%'"
    ];

    if (startDate) {
      conditions.push(`t.${colDate} >= ?`);
      params.push(`${startDate} 00:00:00`);
    }
    if (endDate) {
      conditions.push(`t.${colDate} <= ?`);
      params.push(`${endDate} 23:59:59`);
    }
    if (isExclude) {
      conditions.push(`t.sender NOT LIKE ?`);
      params.push('%tendertiger.com%');
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` ORDER BY t.${colDate} DESC`;

    console.log(`[API] Fetching matched emails. Conditions: ${conditions.join(', ') || 'none'}`);
    const [emails] = await conn.execute(query, params);
    
    // Add formatted ocr snippet
    const formattedEmails = emails.map(e => ({
      ...e,
      ocr_snippet: getOcrSnippet(e.ocr_text)
    }));
    
    res.json(formattedEmails);
  } catch (err) {
    console.error('Failed to load matched emails:', err.message);
    res.status(500).json({ error: 'Failed to load matched emails', details: err.message });
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});


// 8. Generate reply suggestion draft using OpenAI
app.get('/api/emails/:id/reply-suggestion', async (req, res) => {
  const emailId = req.params.id;
  let conn;
  try {
    conn = await getDbConnection();
    const threadsTable = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';
    const colSender = process.env.DB_COL_SENDER || 'sender';

    // Retrieve email body, subject, sender, ocr_text, attach_names, attach_links
    const [rows] = await conn.execute(`
      SELECT ${colSubject} as subject, ${colBody} as body, ${colSender} as sender, ocr_text, attach_names, attach_links, ai_summary
      FROM \`${threadsTable}\` 
      WHERE ${colId} = ?
    `, [emailId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Email thread not found in database.' });
    }

    const email = rows[0];
    
    // Parse attachments
    const names = email.attach_names ? email.attach_names.split(',').map(n => n.trim()) : [];
    const links = email.attach_links ? email.attach_links.split(',').map(l => l.trim()) : [];
    const attachments = names.map((name, i) => ({ name, link: links[i] || '#' }));

    // Generate AI response suggestion
    let suggestion = '';
    const { client, model, error } = getAiClient();
    if (client && !error) {
      try {
        const cleanBody = (email.body || '').replace(/<[^>]*>/g, '').substring(0, 3000);
        
        const prompt = `Based on the following email details, draft a professional, polite, and contextual email reply from the Laser Power & Infra team.
The reply should address the key concerns/requests in the email. Keep it concise (1-2 short paragraphs) and professional.
Do not include subject line or sender headers in your response, just the body of the reply.

Original Email Subject: ${email.subject}
Original Email Content:
${cleanBody}
AI Summary of Email: ${email.ai_summary || ''}`;

        const completion = await client.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: 'You are an expert procurement coordinator drafting a reply to a tender enquiry.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 300,
          temperature: 0.2
        });

        suggestion = completion?.choices?.[0]?.message?.content?.trim();
      } catch (err) {
        console.error('AI reply suggestion failed:', err.message);
      }
    }

    // Fallback template suggestion if AI fails or key is missing
    if (!suggestion) {
      suggestion = `Dear Sir/Madam,\n\nThank you for your communication regarding the subject tender. We have received your query and our technical team is currently reviewing it.\n\nWe will get back to you with the necessary response / documents shortly.\n\nBest regards,\nTender Coordination Team\nLaser Power & Infra Pvt Ltd.`;
    }

    res.json({
      success: true,
      to: email.sender,
      subject: email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`,
      suggestedReply: suggestion,
      attachments: attachments
    });
  } catch (error) {
    console.error('Reply suggestion endpoint failed:', error);
    res.status(500).json({ error: 'Failed to generate suggested reply', details: error.message });
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});

// 9. Send email using SMTP transporter or Mock fallback
app.post('/api/emails/send', async (req, res) => {
  const { to, subject, body, attachments } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Recipient (to), subject, and email body are required.' });
  }

  // Append attachments if any are selected by the user
  let finalBody = body;
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    finalBody += '\n\n---\nAttached Files:\n' + attachments.map(att => `- ${att.name}: ${att.link}`).join('\n');
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser && smtpPass) {
    try {
      console.log(`[SMTP] Attempting to send email to ${to} via ${smtpHost}...`);
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      const info = await transporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'Laser Power & Infra'}" <${smtpUser}>`,
        to,
        subject,
        text: finalBody
      });

      console.log('[SMTP] Email sent successfully:', info.messageId);
      res.json({ success: true, messageId: info.messageId, mode: 'SMTP' });
    } catch (err) {
      console.error('[SMTP] Failed to send email via SMTP:', err.message);
      res.status(500).json({ error: 'Failed to send email via SMTP', details: err.message });
    }
  } else {
    // Mock Mode
    console.log('\n--- [MOCK EMAIL SENT] ---');
    console.log(`Date: ${new Date().toLocaleString()}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log('Body:');
    console.log(finalBody);
    console.log('-------------------------\n');

    // Return success in mock mode
    res.json({ 
      success: true, 
      messageId: `mock_msg_${Math.random().toString(36).substring(2, 15)}`, 
      mode: 'MOCK' 
    });
  }
});

// ----------------------------------------------------
// In-Memory Fallback Database (For offline/DB-disconnected use)
// ----------------------------------------------------
const fallbackEmails = [
  {
    id: "msg_fallback_1",
    thread_id: "thread_fallback_1",
    subject: "Clarification on GEM/2026/B/7429306 - Cables Quantity & Pricing",
    sender: "GeM Portal Support <gem-support@gov.in>",
    date: "2026-06-24 10:30:00",
    date_received: "2026-06-24 10:30:00",
    category: "Tender/RFP/Bid",
    priority: "HIGH",
    is_important: 1,
    user_labels: "Review, Urgent",
    attach_names: "clarification_cables_qty.pdf, amended_bid_clause.pdf",
    attach_links: "https://drive.google.com/file/d/1_gem_clarification_123, https://drive.google.com/file/d/1_gem_clause_456",
    ocr_text: "Clarification on bid quantity for high-voltage XLPE cables. Bid validity must be extended to 90 days. Copper conductor specifications must match Annexure IV.",
    ai_summary: "GeM Support has issued a critical clarification regarding XLPE cables quantity and copper conductor specifications for bid GEM/2026/B/7429306. Action is required by June 30.",
    body: `<html>
      <body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
          <div style="background-color: #0056b3; color: white; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 20px;">Government E-Marketplace (GeM)</h2>
            <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">Official Bid Clarification Notice</p>
          </div>
          <div style="padding: 24px; background-color: #ffffff;">
            <p>Dear Bidder,</p>
            <p>This is an automated alert regarding <strong>Bid Number: GEM/2026/B/7429306</strong> for the supply of <strong>Electrical Cables & Conductors</strong>.</p>
            <p>The buyer has issued a clarification on the cable quantities and pricing clauses. Please review the table below for the updated schedule:</p>
            
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
              <thead>
                <tr style="background-color: #f8f9fa; border-bottom: 2px solid #dee2e6;">
                  <th style="padding: 10px; text-align: left; border: 1px solid #dee2e6;">Item Description</th>
                  <th style="padding: 10px; text-align: right; border: 1px solid #dee2e6;">Original Qty</th>
                  <th style="padding: 10px; text-align: right; border: 1px solid #dee2e6;">Revised Qty</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding: 10px; border: 1px solid #dee2e6;">1.1 KV XLPE Armoured Aluminum Cable 3C x 185 Sqmm</td>
                  <td style="padding: 10px; text-align: right; border: 1px solid #dee2e6;">5,000 m</td>
                  <td style="padding: 10px; text-align: right; border: 1px solid #dee2e6;"><strong>8,500 m</strong></td>
                </tr>
                <tr style="background-color: #fdfdfe;">
                  <td style="padding: 10px; border: 1px solid #dee2e6;">33 KV XLPE Three Core Copper Cable 3C x 300 Sqmm</td>
                  <td style="padding: 10px; text-align: right; border: 1px solid #dee2e6;">1,200 m</td>
                  <td style="padding: 10px; text-align: right; border: 1px solid #dee2e6;"><strong>1,800 m</strong></td>
                </tr>
              </tbody>
            </table>

            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px; margin: 20px 0;">
              <strong style="color: #856404;">URGENT NOTICE:</strong> The submission deadline has been extended to <strong>June 30, 2026, at 15:00 Hrs</strong>. Please ensure all revised price schedules are uploaded before the cutoff.
            </div>

            <p>Please find the official clarification document and revised bid clauses attached to this email.</p>
            <p>Regards,<br/><strong>GeM Portal Support Team</strong></p>
          </div>
          <div style="background-color: #f1f3f5; padding: 15px; text-align: center; font-size: 12px; color: #6c757d; border-top: 1px solid #e0e0e0;">
            This is a system-generated email. Please do not reply directly to this message.
          </div>
        </div>
      </body>
    </html>`
  },
  {
    id: "msg_fallback_2",
    thread_id: "thread_fallback_2",
    subject: "HDFC Bank Statement - Account ending 8324 - June 2026",
    sender: "HDFC Bank Alerts <alerts@hdfcbank.net>",
    date: "2026-06-23 09:15:00",
    date_received: "2026-06-23 09:15:00",
    category: "Banking/Finance",
    priority: "HIGH",
    is_important: 1,
    user_labels: "Finance, HDFC",
    attach_names: "HDFC_Statement_June2026.pdf",
    attach_links: "https://drive.google.com/file/d/1_hdfc_stmt_456",
    ocr_text: "HDFC Bank Ltd. E-Statement of Account. Client: Laser Power & Infra. Balance: INR 4,82,91,042.82. Total Credits: INR 1,50,00,000. Total Debits: INR 92,30,129.",
    ai_summary: "Monthly HDFC Bank e-statement for account ending 8324. Shows a closing balance of INR 4.82 Crores with substantial credit transactions.",
    body: `<html>
      <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #444; background-color: #f5f6f8; padding: 30px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border: 1px solid #e1e4e8; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); overflow: hidden;">
          <div style="background: linear-gradient(135deg, #173267 0%, #004b87 100%); color: white; padding: 25px 30px;">
            <div style="font-size: 24px; font-weight: bold; letter-spacing: 1px;">HDFC BANK</div>
            <div style="font-size: 14px; opacity: 0.8; margin-top: 5px;">We understand your world</div>
          </div>
          <div style="padding: 30px;">
            <h3 style="color: #173267; margin-top: 0; border-bottom: 2px solid #f0f2f5; padding-bottom: 10px;">Monthly E-Statement Notification</h3>
            <p>Dear Customer,</p>
            <p>Your monthly e-statement of account for <strong>LASER POWER & INFRA</strong> for the period ending <strong>23-June-2026</strong> is now available for download.</p>
            
            <div style="background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 20px; margin: 20px 0;">
              <table style="width: 100%; font-size: 14px;">
                <tr>
                  <td style="padding: 5px 0; color: #6c757d;">Account Number:</td>
                  <td style="padding: 5px 0; text-align: right; font-weight: bold; color: #173267;">*****8324</td>
                </tr>
                <tr>
                  <td style="padding: 5px 0; color: #6c757d;">Currency:</td>
                  <td style="padding: 5px 0; text-align: right; font-weight: bold;">INR</td>
                </tr>
                <tr>
                  <td style="padding: 5px 0; color: #6c757d;">Closing Balance:</td>
                  <td style="padding: 5px 0; text-align: right; font-weight: bold; color: #28a745; font-size: 16px;">4,82,91,042.82</td>
                </tr>
              </table>
            </div>

            <p>The statement file is attached as a secure PDF. To open the statement, please use your standard corporate customer password.</p>
            <p>For any queries, please contact your Relationship Manager directly or write to corporate.care@hdfcbank.com.</p>
            <br/>
            <p style="font-size: 13px; color: #6c757d;">Warm Regards,<br/><strong>HDFC Bank Corporate Alerts</strong></p>
          </div>
          <div style="background-color: #f8f9fa; color: #888; font-size: 11px; padding: 20px; text-align: center; border-top: 1px solid #eee;">
            HDFC Bank Ltd. Registered Office: HDFC Bank House, Senapati Bapat Marg, Lower Parel, Mumbai - 400013.
          </div>
        </div>
      </body>
    </html>`
  },
  {
    id: "msg_fallback_3",
    thread_id: "thread_fallback_3",
    subject: "Purchase Order: PO-984210 - Copper Rods & Wire Supply",
    sender: "Industrial Procurement <orders@industrialcorp.com>",
    date: "2026-06-22 14:20:00",
    date_received: "2026-06-22 14:20:00",
    category: "Purchase Order",
    priority: "HIGH",
    is_important: 1,
    user_labels: "PO, Copper, Sales",
    attach_names: "PO_984210_CopperRods.pdf",
    attach_links: "https://drive.google.com/file/d/1_po_984210",
    ocr_text: "PURCHASE ORDER. PO No: PO-984210. Buyer: Industrial Corp Ltd. Seller: Laser Power & Infra. Item: 8mm Copper Rods. Qty: 25 Metric Tons. Unit Price: INR 7,50,000 per MT.",
    ai_summary: "Formal Purchase Order PO-984210 from Industrial Corp for the supply of 25 Metric Tons of 8mm Copper Rods, totaling INR 1.87 Crores.",
    body: `<html>
      <body style="font-family: Calibri, Candara, Segoe, Arial, sans-serif; color: #333; padding: 20px;">
        <div style="max-width: 650px; margin: 0 auto; border: 2px solid #2e7d32; border-radius: 6px; overflow: hidden;">
          <div style="background-color: #2e7d32; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 20px; font-weight: bold; letter-spacing: 0.5px;">PURCHASE ORDER</span>
            <span style="font-size: 14px;">PO NO: <strong>PO-984210</strong></span>
          </div>
          <div style="padding: 25px; background-color: #fff;">
            <p>Dear Team,</p>
            <p>We are pleased to place a formal Purchase Order for the supply of raw materials as per the commercial terms finalized on our contract. Please find the details below:</p>
            
            <div style="margin: 20px 0; border: 1px solid #ccc; border-radius: 4px; padding: 15px; font-size: 14px;">
              <strong>Delivery Address:</strong><br/>
              Industrial Corp Manufacturing Facility, Block B, Sector 6,<br/>
              Industrial Area, Noida, UP - 201301
            </div>

            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
              <thead>
                <tr style="background-color: #f1f8e9; border-bottom: 2px solid #2e7d32;">
                  <th style="padding: 8px; text-align: left; border: 1px solid #ddd;">Item</th>
                  <th style="padding: 8px; text-align: right; border: 1px solid #ddd;">Qty</th>
                  <th style="padding: 8px; text-align: right; border: 1px solid #ddd;">Rate (per MT)</th>
                  <th style="padding: 8px; text-align: right; border: 1px solid #ddd;">Total Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd;">8mm High-Purity Electrolytic Copper Rods (ASTM B49)</td>
                  <td style="padding: 8px; text-align: right; border: 1px solid #ddd;">25 MT</td>
                  <td style="padding: 8px; text-align: right; border: 1px solid #ddd;">INR 7,50,000</td>
                  <td style="padding: 8px; text-align: right; border: 1px solid #ddd;"><strong>INR 1,87,50,000</strong></td>
                </tr>
              </tbody>
            </table>

            <p><strong>Delivery Schedule:</strong> Materials must be delivered in batches starting 10-July-2026. The full order must be fulfilled by 31-July-2026.</p>
            <p>Please sign and return the duplicate copy of this PO as acknowledgment of acceptance within 3 days.</p>
            <p>Sincerely,<br/><strong>Procurement Manager</strong><br/>Industrial Corporation Ltd.</p>
          </div>
        </div>
      </body>
    </html>`
  },
  {
    id: "msg_fallback_4",
    thread_id: "thread_fallback_4",
    subject: "Signed Contract - Laser Power & NBPDCL Supply Agreement",
    sender: "NBPDCL Legal Division <legal@nbpdcl.in>",
    date: "2026-06-21 16:45:00",
    date_received: "2026-06-21 16:45:00",
    category: "Contract/Agreement",
    priority: "HIGH",
    is_important: 1,
    user_labels: "Contract, NBPDCL",
    attach_names: "Supply_Agreement_Conductors_Signed.pdf",
    attach_links: "https://drive.google.com/file/d/1_nbpdcl_contract_777",
    ocr_text: "CONTRACT AGREEMENT. Between North Bihar Power Distribution Company Ltd. (NBPDCL) and Laser Power & Infra. Contract Value: INR 8,92,40,192. Scope: Supply of ACSR Conductors.",
    ai_summary: "Fully executed and signed contract between NBPDCL and Laser Power for the supply of ACSR Conductors, valued at INR 8.92 Crores.",
    body: `Dear Sir,

Please find attached the signed contract agreement copy for the supply of ACSR Conductors under Tender ID NBPDCL/ACSR/2026-07.

The agreement has been formally executed by our Managing Director today. You are requested to submit the Performance Bank Guarantee (PBG) equivalent to 3% of the contract value (INR 26,77,206) within 15 days from the date of this letter to initiate the dispatch schedule.

Kindly acknowledge receipt.

Regards,
Legal & Compliance Officer,
NBPDCL Head Office, Patna.`
  },
  {
    id: "msg_fallback_5",
    thread_id: "thread_fallback_5",
    subject: "MP Eprocurement: Reverse Auction Alert for Bid 2026_PKVVC_499972_1",
    sender: "MP Eprocurement RA Portal <ra-alerts@mpeproc.gov.in>",
    date: "2026-06-20 11:30:00",
    date_received: "2026-06-20 11:30:00",
    category: "Tender/RFP/Bid",
    priority: "HIGH",
    is_important: 1,
    user_labels: "Tender, Reverse Auction",
    attach_names: "RA_Rules_Annexure.pdf",
    attach_links: "https://drive.google.com/file/d/1_ra_rules_888",
    ocr_text: "REVERSE AUCTION NOTICE. Tender Ref: TS-1704. ID: 2026_PKVVC_499972_1. Date: 26-June-2026. Start Time: 11:00 AM. Decrement: 0.1%. Bidder portal access active.",
    ai_summary: "Official e-procurement alert notifying that the Reverse Auction for MP Tender 2026_PKVVC_499972_1 is scheduled for June 26, 2026, starting at 11:00 AM.",
    body: `<html>
      <body style="font-family: system-ui, -apple-system, sans-serif; background-color: #f9f9f9; padding: 20px; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #e65100; color: white; padding: 20px; text-align: center;">
            <h2 style="margin: 0; font-size: 18px;">Madhya Pradesh E-Procurement Portal</h2>
            <p style="margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">IMPORTANT ALERT: REVERSE AUCTION SCHEDULED</p>
          </div>
          <div style="padding: 25px;">
            <p>Dear Bidder,</p>
            <p>You have successfully qualified the technical evaluation for the following tender. The competent authority has scheduled the <strong>Reverse Auction (RA)</strong> process as per details below:</p>
            
            <div style="background-color: #fff8e1; border-left: 4px solid #ffb300; padding: 15px; border-radius: 4px; margin: 20px 0; font-size: 14px;">
              <strong>Tender Reference No:</strong> TS-1704<br/>
              <strong>Tender ID:</strong> 2026_PKVVC_499972_1<br/>
              <strong>Work Description:</strong> Supply of AAC & ACSR Conductors<br/>
              <strong>Auction Date:</strong> June 26, 2026<br/>
              <strong>Auction Start Time:</strong> 11:00 AM IST<br/>
              <strong>RA Decrement Value:</strong> 0.1% of current L1 price
            </div>

            <p><strong>Critical Instructions:</strong></p>
            <ul style="padding-left: 20px; font-size: 13px; color: #555;">
              <li style="margin-bottom: 8px;">Please ensure your Digital Signature Certificate (DSC) is mapped and active.</li>
              <li style="margin-bottom: 8px;">Log in to the portal at least 30 minutes prior to the start of the auction.</li>
              <li style="margin-bottom: 8px;">Review the Reverse Auction Rules and guidelines document attached.</li>
            </ul>

            <p>For portal support, please contact the MP Eprocurement Helpdesk at support-eproc@mp.gov.in.</p>
            <p>Regards,<br/><strong>E-Procurement Administrator</strong></p>
          </div>
        </div>
      </body>
    </html>`
  },
  {
    id: "msg_fallback_6",
    thread_id: "thread_fallback_6",
    subject: "Canara Bank EMD Payment Confirmation - Bid Ref 2026_CAN_948",
    sender: "Canara Bank Alerts <statements@canarabank.com>",
    date: "2026-06-18 16:10:00",
    date_received: "2026-06-18 16:10:00",
    category: "Banking/Finance",
    priority: "MEDIUM",
    is_important: 0,
    user_labels: "EMD, Canara, Finance",
    attach_names: "Canara_NEFT_EMD_Receipt.pdf",
    attach_links: "https://drive.google.com/file/d/1_canara_receipt_789",
    ocr_text: "Canara Bank. NEFT Transaction. Sender: Laser Power & Infra. Beneficiary: MP Paschim Kshetra Vidyut Vitaran. Amount: INR 5,00,000. Status: SUCCESS.",
    ai_summary: "Payment receipt for EMD of INR 5,00,000 via NEFT to MP Paschim Kshetra Vidyut Vitaran from Canara Bank account.",
    body: `Dear customer,

We are pleased to confirm that your NEFT transaction for Earnest Money Deposit (EMD) has been successfully processed.

Transaction Summary:
- Debit Account: Laser Power & Infra (A/c *****1023)
- Beneficiary: MP Paschim Kshetra Vidyut Vitaran Co. Ltd.
- Amount: INR 5,00,000.00
- UTR Number: CNRB0029304818210
- Status: Completed Successfully
- Date: 18-June-2026 15:45:00

An official stamped NEFT receipt is attached to this email for your tender bid uploads.

Thank you for banking with Canara Bank.

Sincerely,
Canara Bank Corporate Banking Division.`
  },
  {
    id: "msg_fallback_7",
    thread_id: "thread_fallback_7",
    subject: "Invoice: INV-2026-0042 - Copper Ingots Delivery",
    sender: "Copper Suppliers Ltd <billing@coppersuppliers.co.in>",
    date: "2026-06-17 12:45:00",
    date_received: "2026-06-17 12:45:00",
    category: "Invoice/Billing",
    priority: "MEDIUM",
    is_important: 0,
    user_labels: "Invoice, Copper, Finance",
    attach_names: "Invoice_INV_2026_0042.pdf",
    attach_links: "https://drive.google.com/file/d/1_invoice_0042",
    ocr_text: "TAX INVOICE. Copper Suppliers Ltd. GSTIN: 27AABCS98210Z3. Invoice No: INV-2026-0042. Client: Laser Power. Amount: INR 45,92,100. Tax: 18% GST.",
    ai_summary: "Tax invoice INV-2026-0042 from Copper Suppliers Ltd for 6 Metric Tons of Copper Ingots, totaling INR 45.92 Lakhs (inclusive of GST).",
    body: `<html>
      <body style="font-family: Arial, sans-serif; padding: 15px;">
        <h3>Copper Suppliers Limited</h3>
        <p>Dear Accounts Team,</p>
        <p>Please find attached our Tax Invoice <strong>INV-2026-0042</strong> dated 17-June-2026 for materials delivered under delivery challan DC-48201.</p>
        
        <div style="padding: 10px; border: 1px solid #ddd; width: 350px; background-color: #f9f9f9; font-size: 14px; line-height: 1.4;">
          <strong>Invoice Details:</strong><br/>
          Invoice No: INV-2026-0042<br/>
          Date: 17-June-2026<br/>
          Amount Due: <strong>INR 45,92,100.00</strong><br/>
          Payment Terms: Net 30 Days
        </div>

        <p>Please process the payment via RTGS to our Bank of Baroda account listed on the invoice and share the payment advice.</p>
        <p>For delivery queries, contact Mr. Rajesh Verma (dispatch@coppersuppliers.co.in).</p>
        <p>Regards,<br/>Finance Desk<br/>Copper Suppliers Ltd.</p>
      </body>
    </html>`
  },
  {
    id: "msg_fallback_8",
    thread_id: "thread_fallback_8",
    subject: "Enquiry: Cable Price List & Catalog for Bangalore Metro Project",
    sender: "Tech Parks India <info@techparks.in>",
    date: "2026-06-15 14:10:00",
    date_received: "2026-06-15 14:10:00",
    category: "Client Communication",
    priority: "MEDIUM",
    is_important: 0,
    user_labels: "Enquiry, Metro, Sales",
    attach_names: "",
    attach_links: "",
    ocr_text: "",
    ai_summary: "Commercial inquiry from Tech Parks India requesting product catalog and price list for 1.1KV and 11KV power cables for a metro project in Bangalore.",
    body: `Dear Sales Team,

We are a leading infrastructure developer working on a commercial tech park near Bangalore Metro Phase 2.

We require a large quantity of power cables for our internal electrical distribution network. Could you please share:
1. Your latest product catalog for 1.1KV and 11KV XLPE Armoured Cables (Aluminum & Copper).
2. The price list or standard commercial terms.
3. Your manufacturing lead time for an order of approximately 15,000 meters.

We look forward to your prompt response to initiate discussion.

Best regards,
Anand K. Singh,
Procurement Head, Tech Parks India Pvt. Ltd., Bangalore.`
  },
  {
    id: "msg_fallback_9",
    thread_id: "thread_fallback_9",
    subject: "Steel Core Wire Delivery Status - Dispatch Challan SD-9421",
    sender: "Steel Wire Corp <logistics@steelwire.com>",
    date: "2026-06-14 10:20:00",
    date_received: "2026-06-14 10:20:00",
    category: "Vendor/Supplier",
    priority: "LOW",
    is_important: 0,
    user_labels: "Steel, Vendor, Dispatch",
    attach_names: "Challan_SD_9421.pdf",
    attach_links: "https://drive.google.com/file/d/1_steel_challan_111",
    ocr_text: "DISPATCH CHALLAN. Steel Wire Corp. Challan No: SD-9421. Consignee: Laser Power & Infra. Item: High Tensile Steel Core Wire. Qty: 12 MT.",
    ai_summary: "Logistics update from Steel Wire Corp confirming the dispatch of 12 Metric Tons of High Tensile Steel Core Wire via transport vehicle UP-16-AT-9432.",
    body: `Dear Sir,

We have dispatched the 12 Metric Tons of High Tensile Steel Core Wire ordered under PO-948210 today.

The consignment is shipped via Shree Balaji Roadlines (Vehicle No: UP-16-AT-9432) and is expected to reach your Haridwar factory by June 17, 2026.

The Dispatch Challan SD-9421 and weighbridge slip are attached for your gate entry team.

Best Regards,
Logistics Team, Steel Wire Corp.`
  },
  {
    id: "msg_fallback_10",
    thread_id: "thread_fallback_10",
    subject: "Industry Newsletter - June 2026: Metal Prices & Trends",
    sender: "Metal Bulletin <newsletter@metalbulletin.org>",
    date: "2026-06-12 09:00:00",
    date_received: "2026-06-12 09:00:00",
    category: "General",
    priority: "LOW",
    is_important: 0,
    user_labels: "Newsletter, Metals",
    attach_names: "",
    attach_links: "",
    ocr_text: "",
    ai_summary: "Monthly newsletter from Metal Bulletin highlighting the global copper and aluminum price trends, highlighting a 3% surge in copper LME prices.",
    body: `<html>
      <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 15px; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; border: 1px solid #ddd; border-radius: 4px; padding: 20px;">
          <h2 style="color: #d32f2f; border-bottom: 2px solid #d32f2f; padding-bottom: 10px; margin-top: 0;">METAL BULLETIN NEWSLETTER</h2>
          <p style="font-size: 13px; color: #666;">Monthly Trends & Price Forecasts - June 2026</p>
          
          <h4 style="color: #333; margin-bottom: 5px;">1. Copper Prices Hit 6-Month High on LME</h4>
          <p style="font-size: 14px; line-height: 1.5; color: #555; margin-top: 0;">
            Global copper prices surged by 3.2% this week on the London Metal Exchange (LME) due to supply disruptions in key South American mines and robust demand from the green energy and electrical grids manufacturing sectors. Analysts expect prices to hover around USD 9,200/MT for the next quarter.
          </p>

          <h4 style="color: #333; margin-bottom: 5px;">2. Aluminum Output Expands in Asia</h4>
          <p style="font-size: 14px; line-height: 1.5; color: #555; margin-top: 0;">
            Aluminum production has expanded by 1.8% month-on-month in China and India, keeping domestic prices relatively stable despite increased shipping costs.
          </p>

          <div style="background-color: #eee; padding: 10px; text-align: center; font-size: 11px; color: #777; margin-top: 20px;">
            You are receiving this email because you subscribed to Metal Bulletin. To unsubscribe, click here.
          </div>
        </div>
      </body>
    </html>`
  }
];

// Helper to filter, search and paginate emails in-memory
function filterFallbackEmails(queryObj) {
  const { category, search, label, startDate, endDate, page = 1, limit = 50 } = queryObj;
  
  let result = [...fallbackEmails];

  // Apply filters
  if (category) {
    result = result.filter(e => e.category === category);
  }

  if (label) {
    result = result.filter(e => {
      if (!e.user_labels) return false;
      const tags = e.user_labels.split(',').map(t => t.trim().toLowerCase());
      return tags.includes(label.toLowerCase());
    });
  }

  if (startDate) {
    const start = new Date(startDate + 'T00:00:00');
    result = result.filter(e => new Date(e.date) >= start);
  }

  if (endDate) {
    const end = new Date(endDate + 'T23:59:59');
    result = result.filter(e => new Date(e.date) <= end);
  }

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e => 
      (e.subject && e.subject.toLowerCase().includes(q)) ||
      (e.sender && e.sender.toLowerCase().includes(q)) ||
      (e.body && e.body.toLowerCase().includes(q)) ||
      (e.ocr_text && e.ocr_text.toLowerCase().includes(q))
    );
  }

  // Sort by date DESC
  result.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Pagination
  const total = result.length;
  const offset = (Number(page) - 1) * Number(limit);
  const paginated = result.slice(offset, offset + Number(limit));

  return {
    success: true,
    total,
    page: Number(page),
    limit: Number(limit),
    emails: paginated.map(e => ({
      id: e.id,
      thread_id: e.thread_id,
      subject: e.subject,
      sender: e.sender,
      date: e.date,
      date_received: e.date_received,
      category: e.category,
      priority: e.priority,
      is_important: e.is_important,
      user_labels: e.user_labels,
      attach_names: e.attach_names,
      attach_links: e.attach_links,
      body_preview: e.body ? e.body.replace(/<[^>]*>/g, '').substring(0, 300) : ''
    }))
  };
}

// 10. Get All Emails from database (paginated, with search & category & custom label filtering)
app.get('/api/all-emails', async (req, res) => {
  let conn;
  try {
    conn = await getDbConnection();
    const table = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';
    const colSender = process.env.DB_COL_SENDER || 'sender';
    const colDate = process.env.DB_COL_DATE || 'date';

    const { category, search, label, startDate, endDate, page = 1, limit = 50, excludeTenderTiger } = req.query;
    const isExclude = excludeTenderTiger === 'true';
    const offset = (Number(page) - 1) * Number(limit);

    let query = `SELECT ${colId} as id, thread_id, ${colSubject} as subject, ${colSender} as sender, ${colDate} as date, 
                        category, priority, is_important, user_labels, attach_names, attach_links, 
                        LEFT(${colBody}, 300) as body_preview 
                 FROM \`${table}\``;
    let countQuery = `SELECT COUNT(*) as total FROM \`${table}\``;
    
    let conditions = [];
    let params = [];

    // Filter out blacklisted senders
    conditions.push(`${colSender} NOT LIKE '%protulchatterjee2020@gmail.com%' AND ${colSender} NOT LIKE '%biswajit@omclearing.com%' AND ${colSender} NOT LIKE '%automation@app.smartsheet.com%'`);

    if (isExclude) {
      conditions.push(`${colSender} NOT LIKE ?`);
      params.push('%tendertiger.com%');
    }

    if (category) {
      conditions.push(`category = ?`);
      params.push(category);
    }
    if (label) {
      conditions.push(`FIND_IN_SET(?, REPLACE(user_labels, ', ', ',')) > 0`);
      params.push(label);
    }
    if (startDate) {
      conditions.push(`${colDate} >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`${colDate} <= ?`);
      params.push(endDate);
    }
    if (search) {
      conditions.push(`(${colSubject} LIKE ? OR ${colSender} LIKE ? OR ${colBody} LIKE ? OR ocr_text LIKE ?)`);
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    if (conditions.length > 0) {
      const whereClause = ` WHERE ` + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ` ORDER BY ${colDate} DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
    
    const [countRows] = await conn.execute(countQuery, params);
    const total = countRows[0].total;

    const [rows] = await conn.execute(query, params);

    res.json({
      success: true,
      total,
      page: Number(page),
      limit: Number(limit),
      emails: rows
    });
  } catch (error) {
    console.warn('[DB Error] Falling back to in-memory mock emails:', error.message);
    const fallbackResult = filterFallbackEmails(req.query);
    res.json(fallbackResult);
  } finally {
    if (conn) await conn.end();
  }
});

// 11. Get specific email details (returns full body and attachment metadata)
app.get('/api/emails/:id', async (req, res) => {
  let conn;
  try {
    conn = await getDbConnection();
    const table = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';
    const colSender = process.env.DB_COL_SENDER || 'sender';
    const colDate = process.env.DB_COL_DATE || 'date';

    const [rows] = await conn.execute(`
      SELECT ${colId} as id, thread_id, ${colSubject} as subject, ${colBody} as body, ${colSender} as sender, ${colDate} as date,
             category, sub_category, priority, is_important, user_labels, attach_names, attach_links, ocr_text, ai_summary
      FROM \`${table}\`
      WHERE ${colId} = ?
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.warn('[DB Error] Getting specific email details from fallback:', error.message);
    const email = fallbackEmails.find(e => String(e.id) === String(req.params.id));
    if (!email) {
      return res.status(404).json({ error: 'Email not found in fallback cache' });
    }
    res.json(email);
  } finally {
    if (conn) await conn.end();
  }
});

// 12. Update custom labels for a specific email & propagate to related emails using AI
app.post('/api/emails/:id/labels', async (req, res) => {
  let conn;
  try {
    const { labels } = req.body; // Array of string labels or single string
    let labelStr = null;
    let newLabelsList = [];
    if (Array.isArray(labels)) {
      newLabelsList = labels.map(l => l.trim()).filter(l => l !== '');
      labelStr = newLabelsList.join(', ');
    } else if (typeof labels === 'string') {
      newLabelsList = labels.split(',').map(l => l.trim()).filter(l => l !== '');
      labelStr = newLabelsList.join(', ');
    }

    conn = await getDbConnection();
    const table = process.env.DB_TABLE || 'threads';
    const colId = process.env.DB_COL_ID || 'id';
    const colSubject = process.env.DB_COL_SUBJECT || 'subject';
    const colBody = process.env.DB_COL_BODY || 'body';
    const colSender = process.env.DB_COL_SENDER || 'sender';

    const emailId = req.params.id;

    // 1. Fetch the target email to get details and its previous labels
    const [emailRows] = await conn.execute(`
      SELECT ${colId} as id, ${colSubject} as subject, ${colBody} as body, ${colSender} as sender, user_labels
      FROM \`${table}\`
      WHERE ${colId} = ?
    `, [emailId]);

    if (emailRows.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const targetEmail = emailRows[0];
    const prevLabelsList = targetEmail.user_labels 
      ? targetEmail.user_labels.split(',').map(l => l.trim()).filter(l => l !== '')
      : [];

    // 2. Identify newly added labels
    const newlyAddedLabels = newLabelsList.filter(l => !prevLabelsList.includes(l));

    // 3. Update the target email's labels in the database
    await conn.execute(`
      UPDATE \`${table}\`
      SET user_labels = ?
      WHERE ${colId} = ?
    `, [labelStr, emailId]);

    let totalPropagated = 0;
    const propagatedDetails = [];

    // 4. Trigger AI propagation for each newly added label
    const { client, model, error } = getAiClient();
    if (newlyAddedLabels.length > 0 && client && !error) {
      for (const newLabel of newlyAddedLabels) {
        try {
          console.log(`[AI Label Propagation] Analyzing email for new label: "${newLabel}"`);
          
          // Step A: AI Rule Generation (one tiny API call)
          const rulePrompt = `Analyze the following email which was labeled "${newLabel}".
Generate a list of 2 to 4 highly specific keyword phrases (such as project names, PO numbers, unique company names, or distinct subject tokens) that uniquely identify emails related to this exact topic.
Optionally, specify a sender domain to match.
Respond with strict JSON only in this exact shape:
{
  "sqlKeywords": ["phrase1", "phrase2"],
  "senderDomain": "optional_domain_to_match.com"
}

Subject: ${targetEmail.subject}
Sender: ${targetEmail.sender}
Body Preview: ${(targetEmail.body || '').substring(0, 800)}`;

          const ruleCompletion = await client.chat.completions.create({
            model: model,
            messages: [
              { role: 'system', content: 'You generate highly specific search rules. Respond with strict JSON only.' },
              { role: 'user', content: rulePrompt }
            ],
            max_tokens: 150,
            temperature: 0
          });

          const ruleContent = ruleCompletion?.choices?.[0]?.message?.content?.trim();
          if (!ruleContent) continue;

          const rule = extractRuleFromJson(ruleContent);
          const keywords = Array.isArray(rule.sqlKeywords) ? rule.sqlKeywords.filter(k => k.trim().length > 1) : [];
          const senderDomain = typeof rule.senderDomain === 'string' ? rule.senderDomain.trim() : '';

          if (keywords.length === 0 && !senderDomain) {
            console.log(`[AI Label Propagation] No rules generated for "${newLabel}".`);
            continue;
          }

          // Step B: SQL Candidate Search (Zero-token DB query)
          let sql = `
            SELECT ${colId} as id, ${colSubject} as subject, ${colSender} as sender, LEFT(${colBody}, 250) as body_preview, user_labels
            FROM \`${table}\`
            WHERE ${colId} != ?
          `;
          const sqlParams = [emailId];
          const searchConditions = [];

          if (senderDomain) {
            searchConditions.push(`${colSender} LIKE ?`);
            sqlParams.push(`%${senderDomain}%`);
          }

          keywords.forEach(kw => {
            searchConditions.push(`${colSubject} LIKE ? OR ${colBody} LIKE ?`);
            sqlParams.push(`%${kw}%`, `%${kw}%`);
          });

          if (searchConditions.length > 0) {
            sql += ` AND (${searchConditions.join(' OR ')})`;
          }

          // Exclude blacklisted senders
          sql += `
            AND ${colSender} NOT LIKE '%protulchatterjee2020@gmail.com%'
            AND ${colSender} NOT LIKE '%biswajit@omclearing.com%'
            AND ${colSender} NOT LIKE '%automation@app.smartsheet.com%'
            AND ${colSender} NOT LIKE '%tendertiger.com%'
          `;

          // Limit to 60 candidates to be extremely token-efficient
          sql += ` LIMIT 60`;

          const [candidates] = await conn.execute(sql, sqlParams);
          console.log(`[AI Label Propagation] SQL search found ${candidates.length} candidates for "${newLabel}"`);

          if (candidates.length > 0) {
            // Step C: AI Batch Validation (one single, highly compact API call)
            const compactCandidates = candidates.map(c => ({
              id: c.id,
              subject: c.subject,
              sender: c.sender,
              body_preview: c.body_preview
            }));

            const valPrompt = `The user has labeled the following reference email as "${newLabel}":
Subject: ${targetEmail.subject}
Sender: ${targetEmail.sender}
Body Snippet: ${(targetEmail.body || '').substring(0, 400)}

Below is a list of candidate emails. Select the IDs of the emails that are highly related to the reference email and should also receive the "${newLabel}" label.
Respond with strict JSON only (a flat array of matching integer IDs):
[id1, id2, ...]

Candidates:
${JSON.stringify(compactCandidates, null, 2)}`;

            const valCompletion = await client.chat.completions.create({
              model: model,
              messages: [
                { role: 'system', content: 'You select matching email IDs based on reference content. Respond with a JSON array of matching IDs only.' },
                { role: 'user', content: valPrompt }
              ],
              max_tokens: 150,
              temperature: 0
            });

            const valContent = valCompletion?.choices?.[0]?.message?.content?.trim();
            if (valContent) {
              const matchedIds = extractArrayFromJson(valContent);
              if (Array.isArray(matchedIds) && matchedIds.length > 0) {
                // Step D: Database Label Update
                const idsToUpdate = matchedIds.map(id => Number(id)).filter(id => !isNaN(id));
                
                if (idsToUpdate.length > 0) {
                  const placeholders = idsToUpdate.map(() => '?').join(',');
                  const [emailsToUpdate] = await conn.execute(`
                    SELECT ${colId} as id, ${colSubject} as subject, user_labels FROM \`${table}\`
                    WHERE ${colId} IN (${placeholders})
                  `, idsToUpdate);

                  for (const email of emailsToUpdate) {
                    const currentLabels = email.user_labels 
                      ? email.user_labels.split(',').map(l => l.trim()).filter(l => l !== '')
                      : [];
                    
                    if (!currentLabels.includes(newLabel)) {
                      currentLabels.push(newLabel);
                      const updatedLabelsStr = currentLabels.join(', ');
                      
                      await conn.execute(`
                        UPDATE \`${table}\`
                        SET user_labels = ?
                        WHERE ${colId} = ?
                      `, [updatedLabelsStr, email.id]);

                      totalPropagated++;
                      propagatedDetails.push({ id: email.id, subject: email.subject });
                    }
                  }
                }
              }
            }
          }
        } catch (aiErr) {
          console.error(`[AI Label Propagation Failed] for "${newLabel}":`, aiErr.message);
        }
      }
    }

    res.json({ 
      success: true, 
      labels: labelStr,
      propagatedCount: totalPropagated,
      propagatedEmails: propagatedDetails
    });
  } catch (error) {
    console.warn('[DB Error] Updating custom labels:', error.message);
    
    // Fallback cache logic
    const { labels } = req.body;
    let labelStr = '';
    if (Array.isArray(labels)) {
      labelStr = labels.map(l => l.trim()).filter(l => l !== '').join(', ');
    } else if (typeof labels === 'string') {
      labelStr = labels.trim();
    }
    
    const email = fallbackEmails.find(e => String(e.id) === String(req.params.id));
    if (email) {
      email.user_labels = labelStr;
      res.json({ success: true, labels: labelStr, fallbackMode: true });
    } else {
      res.status(500).json({ error: 'Failed to update custom labels', details: error.message });
    }
  } finally {
    if (conn) {
      await conn.end();
    }
  }
});

// 13. Get list of all unique custom labels currently assigned in the database
app.get('/api/labels', async (req, res) => {
  let conn;
  try {
    conn = await getDbConnection();
    const table = process.env.DB_TABLE || 'threads';
    const [rows] = await conn.execute(`
      SELECT DISTINCT user_labels FROM \`${table}\` WHERE user_labels IS NOT NULL AND user_labels != ''
    `);
    
    const uniqueLabels = new Set();
    rows.forEach(r => {
      if (r.user_labels) {
        r.user_labels.split(',').forEach(l => {
          const clean = l.trim();
          if (clean) uniqueLabels.add(clean);
        });
      }
    });

    res.json(Array.from(uniqueLabels).sort());
  } catch (error) {
    console.warn('[DB Error] Fetching unique labels from fallback:', error.message);
    const uniqueLabels = new Set();
    fallbackEmails.forEach(e => {
      if (e.user_labels) {
        e.user_labels.split(',').forEach(l => {
          const clean = l.trim();
          if (clean) uniqueLabels.add(clean);
        });
      }
    });
    res.json(Array.from(uniqueLabels).sort());
  } finally {
    if (conn) await conn.end();
  }
});

// Serve frontend assets in production
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/*splat', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Start background automatic sync (default: 4 hours / 14,400,000 ms)
// To change interval: set SYNC_INTERVAL_MS environment variable (in milliseconds)
// To force full sync of all data: set FORCE_FULL_SYNC=true
const AUTO_SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL_MS) || 4 * 60 * 60 * 1000;  // 4 hours
console.log(`Scheduling background auto-sync every ${AUTO_SYNC_INTERVAL / 1000} seconds (${AUTO_SYNC_INTERVAL / (60 * 60 * 1000)} hours).`);
setInterval(async () => {
  try {
    await runSync();
  } catch (err) {
    // If sync is already running (e.g. user triggered manual sync), we skip silently
    if (err.message !== 'Sync already in progress') {
      console.error('Scheduled background sync failed:', err.message);
    }
  }
}, AUTO_SYNC_INTERVAL);

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
