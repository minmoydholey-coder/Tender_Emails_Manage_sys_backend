const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false
  }
};

const dbName = process.env.DB_NAME || 'defaultdb';
const tableName = process.env.DB_TABLE || 'threads';

const mockEmails = [
  {
    id: "msg_18a6e701aef381b1",
    thread_id: "thread_18a6e701aef381b1",
    related_ids: "msg_18a6e701aef381b1",
    msg_count: 1,
    date: "2026-06-15 10:30:00",
    sender: "gem-support@gov.in",
    sender_details: "GeM Portal Support <gem-support@gov.in>",
    cc_details: "",
    subject: "Clarification on GEM/2026/B/7429306 - Cables Quantity",
    body: "Hi Team, Regarding the GeM bid GEM/2026/B/7429306, the client has issued an amendment to the cables quantity. Please check updated documents on GeM portal and prepare bid accordingly.",
    attach_names: "amendment_1.pdf",
    attach_links: "http://drive.google.com/file1",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-15 10:30:00",
    message_ids: "<gem-129@gov.in>",
    drive_folder_id: "folder_123",
    sub_category: "Amendments",
    priority: "HIGH",
    is_important: true,
    importance_reasons: "Tender deadline approaching"
  },
  {
    id: "msg_18a6e702bef382b2",
    thread_id: "thread_18a6e702bef382b2",
    related_ids: "msg_18a6e702bef382b2",
    msg_count: 1,
    date: "2026-06-14 11:20:00",
    sender: "procurement@bescom.co.in",
    sender_details: "BESCOM <procurement@bescom.co.in>",
    cc_details: "",
    subject: "Tender Bid preparation for BESCOM/2026-27/IND0231",
    body: "Dear Sir, The bid submission date for BESCOM/2026-27/IND0231 is fast approaching. Please prepare the technical documents and submit the EMD payment. Regards, BESCOM Procurement.",
    attach_names: "nit_details.pdf",
    attach_links: "http://drive.google.com/file2",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-14 11:20:00",
    message_ids: "<bescom-9432@bescom.co.in>",
    drive_folder_id: "folder_124",
    sub_category: "NIT",
    priority: "MEDIUM",
    is_important: false,
    importance_reasons: ""
  },
  {
    id: "msg_18a6e703cef383c3",
    thread_id: "thread_18a6e703cef383c3",
    related_ids: "msg_18a6e703cef383c3",
    msg_count: 1,
    date: "2026-06-16 15:45:00",
    sender: "ra-alerts@mpeproc.gov.in",
    sender_details: "MP Eprocurement RA Portal <ra-alerts@mpeproc.gov.in>",
    cc_details: "",
    subject: "Notification of Reverse Auction - 2026_PKVVC_499972_1",
    body: "Dear Bidder, The reverse auction for Tender Ref TS 1704 AAA and ID 2026_PKVVC_499972_1 is scheduled for June 20th at 11:00 AM. Please log in to the e-procurement portal to participate.",
    attach_names: "",
    attach_links: "",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-16 15:45:00",
    message_ids: "<ra-alert-321@mpeproc.gov.in>",
    drive_folder_id: "folder_125",
    sub_category: "Reverse Auction",
    priority: "HIGH",
    is_important: true,
    importance_reasons: "Reverse auction date scheduled"
  },
  {
    id: "msg_18a6e704def384d4",
    thread_id: "thread_18a6e704def384d4",
    related_ids: "msg_18a6e704def384d4",
    msg_count: 1,
    date: "2026-06-12 09:00:00",
    sender: "design@jpng.com",
    sender_details: "JP Design Group <design@jpng.com>",
    cc_details: "",
    subject: "Drawings revised for JP/B862-000-XT-MR-0220/80",
    body: "Kindly find attached revised drawings for JP/B862-000-XT-MR-0220/80. Submit revised pricing and commercial offer. Ensure this is uploaded on the site.",
    attach_names: "revised_drawings.dwg",
    attach_links: "http://drive.google.com/file3",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-12 09:00:00",
    message_ids: "<jp-design-019@jpng.com>",
    drive_folder_id: "folder_126",
    sub_category: "Drawings",
    priority: "MEDIUM",
    is_important: false,
    importance_reasons: ""
  },
  {
    id: "msg_18a6e705eef385e5",
    thread_id: "thread_18a6e705eef385e5",
    related_ids: "msg_18a6e705eef385e5",
    msg_count: 1,
    date: "2026-06-13 14:10:00",
    sender: "support@epmportal.com",
    sender_details: "EPMPortal Support <support@epmportal.com>",
    cc_details: "",
    subject: "Pre-bid query replies: EPMPT-04/26-27 (Tender ID 929611)",
    body: "The pre-bid meeting clarifications for System Tender 929611 (Notice No. EPMPT-04/26-27) have been published on the e-portal. Check section 4 for technical query replies.",
    attach_names: "clarifications.pdf",
    attach_links: "http://drive.google.com/file4",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-13 14:10:00",
    message_ids: "<epmp-clarify-92@epmportal.com>",
    drive_folder_id: "folder_127",
    sub_category: "Clarifications",
    priority: "MEDIUM",
    is_important: false,
    importance_reasons: ""
  },
  {
    id: "msg_18a6e706fef386f6",
    thread_id: "thread_18a6e706fef386f6",
    related_ids: "msg_18a6e706fef386f6",
    msg_count: 1,
    date: "2026-06-17 08:30:00",
    sender: "no-reply@eproc.gov.in",
    sender_details: "EProc Portal Alerts <no-reply@eproc.gov.in>",
    cc_details: "",
    subject: "Bid Submission Confirmation - Tender ID 299435",
    body: "Your bid for Tender ID- 299435 has been successfully uploaded and registered. Docket No: DK-99221. Bid Validity: 90 days from submission date.",
    attach_names: "submission_receipt.pdf",
    attach_links: "http://drive.google.com/file5",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-17 08:30:00",
    message_ids: "<receipt-299435@eproc.gov.in>",
    drive_folder_id: "folder_128",
    sub_category: "Receipt",
    priority: "MEDIUM",
    is_important: true,
    importance_reasons: "Confirmation of bid upload"
  },
  {
    id: "msg_18a6e707aef387a7",
    thread_id: "thread_18a6e707aef387a7",
    related_ids: "msg_18a6e707aef387a7",
    msg_count: 1,
    date: "2026-06-17 11:00:00",
    sender: "ee-projects@nbpdcl.in",
    sender_details: "NBPDCL Executive Engineer <ee-projects@nbpdcl.in>",
    cc_details: "",
    subject: "Technical queries for 30/PR/NBPDCL/2026",
    body: "Dear Sir, This is regarding System Tender No. 129842 (Tender Reference No. 30/PR/NBPDCL/2026). Please answer technical queries in Annexure A by June 22. Failure to do so will result in technical disqualification.",
    attach_names: "Annexure_A.pdf",
    attach_links: "http://drive.google.com/file6",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-17 11:00:00",
    message_ids: "<nbpdcl-q-129842@nbpdcl.in>",
    drive_folder_id: "folder_129",
    sub_category: "Queries",
    priority: "HIGH",
    is_important: true,
    importance_reasons: "Action required - technical queries"
  },
  {
    id: "msg_18a6e708bef388b8",
    thread_id: "thread_18a6e708bef388b8",
    related_ids: "msg_18a6e708bef388b8",
    msg_count: 1,
    date: "2026-06-17 12:15:00",
    sender: "xen-mm2@haryana.gov.in",
    sender_details: "XEN MM2 HBC Haryana <xen-mm2@haryana.gov.in>",
    cc_details: "",
    subject: "Extension of Bid Submission: 2026_HBC_520685_1",
    body: "The last date for Tender ID 2026_HBC_520685_1 (Ref 01/XEN/P-III/MM/QH-II/2136) has been extended to 30.06.2026 due to technical issues in portal.",
    attach_names: "corrigendum_1.pdf",
    attach_links: "http://drive.google.com/file7",
    ocr_text: "",
    ai_summary: "",
    category: "Tenders",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-17 12:15:00",
    message_ids: "<hbc-ext-520685@haryana.gov.in>",
    drive_folder_id: "folder_130",
    sub_category: "Corrigendum",
    priority: "HIGH",
    is_important: true,
    importance_reasons: "Tender date extended"
  },
  {
    id: "msg_18a6e709cef389c9",
    thread_id: "thread_18a6e709cef389c9",
    related_ids: "msg_18a6e709cef389c9",
    msg_count: 1,
    date: "2026-06-11 16:30:00",
    sender: "info@privateclient.com",
    sender_details: "Private Client Info <info@privateclient.com>",
    cc_details: "",
    subject: "General Enquiry about Cables",
    body: "Hello, we are looking for rabbit and dog conductors for our local project. Can you send a catalog and price list? We need 5000 meters. Thanks.",
    attach_names: "",
    attach_links: "",
    ocr_text: "",
    ai_summary: "",
    category: "General",
    contacts: "",
    footprint: "",
    last_updated: "2026-06-11 16:30:00",
    message_ids: "<enquiry-cable-42@privateclient.com>",
    drive_folder_id: "folder_131",
    sub_category: "Sales",
    priority: "LOW",
    is_important: false,
    importance_reasons: ""
  }
];

async function run() {
  console.log(`Connecting to MySQL at ${dbConfig.host}:${dbConfig.port}...`);
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log("Connected successfully.");

    // Create database if not exists
    console.log(`Creating database "${dbName}" if it doesn't exist...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);

    // Check if threads table already exists
    const [tables] = await connection.query(`SHOW TABLES LIKE '${tableName}'`);
    if (tables.length > 0) {
      // Check if it has data
      const [rows] = await connection.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
      const count = rows[0].count;
      if (count > 0) {
        console.log(`⚠️  Table "${tableName}" already exists and has ${count} records. To prevent data loss, we will NOT overwrite this table!`);
      } else {
        console.log(`Table "${tableName}" exists but is empty. Populating mock data...`);
        await populateMockThreads(connection);
      }
    } else {
      console.log(`Creating table "${tableName}" with 24 columns...`);
      await createThreadsTable(connection);
      await populateMockThreads(connection);
    }

    // Create tender_matches table
    console.log("Creating table \"tender_matches\" if it doesn't exist...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tender_matches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        docket_no VARCHAR(100),
        tender_no TEXT,
        thread_db_id VARCHAR(255),
        thread_id VARCHAR(255),
        matched_token VARCHAR(255),
        confidence VARCHAR(50),
        matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_match (docket_no, thread_db_id)
      )
    `);

    console.log("Mock database setup complete! 🎉");
  } catch (error) {
    console.error("❌ Database setup failed:", error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

async function createThreadsTable(connection) {
  const createTableQuery = `
    CREATE TABLE \`${tableName}\` (
      id VARCHAR(255) PRIMARY KEY,
      thread_id VARCHAR(255) NOT NULL,
      related_ids TEXT,
      msg_count INT DEFAULT 1,
      date DATETIME NOT NULL,
      sender VARCHAR(255),
      sender_details TEXT,
      cc_details TEXT,
      subject VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      attach_names TEXT,
      attach_links TEXT,
      ocr_text TEXT,
      ai_summary TEXT,
      category VARCHAR(100),
      contacts TEXT,
      footprint TEXT,
      last_updated DATETIME,
      message_ids TEXT,
      drive_folder_id VARCHAR(255),
      sub_category VARCHAR(100),
      priority VARCHAR(50) DEFAULT 'NORMAL',
      is_important BOOLEAN DEFAULT FALSE,
      importance_reasons TEXT
    )
  `;
  await connection.query(createTableQuery);
}

async function populateMockThreads(connection) {
  console.log(`Inserting mock data into "${tableName}"...`);
  const columns = [
    'id', 'thread_id', 'related_ids', 'msg_count', 'date', 'sender', 'sender_details',
    'cc_details', 'subject', 'body', 'attach_names', 'attach_links', 'ocr_text',
    'ai_summary', 'category', 'contacts', 'footprint', 'last_updated', 'message_ids',
    'drive_folder_id', 'sub_category', 'priority', 'is_important', 'importance_reasons'
  ];

  const valuePlaceholder = columns.map(() => '?').join(', ');
  const insertQuery = `INSERT INTO \`${tableName}\` (${columns.join(', ')}) VALUES (${valuePlaceholder})`;

  for (const email of mockEmails) {
    const values = columns.map(col => email[col]);
    await connection.query(insertQuery, values);
  }
  console.log(`Inserted ${mockEmails.length} mock emails.`);
}

run();
