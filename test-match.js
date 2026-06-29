const { extractTenderTokens, checkMatch } = require('./matcher');

const testCases = [
  {
    raw: "GEM/2026/B/7429306",
    expectedTokens: ["GEM/2026/B/7429306"],
    emailsToTest: [
      { subject: "Regarding tender GEM/2026/B/7429306 submission", body: "Hello team, please see details.", shouldMatch: true, confidence: "HIGH" },
      { subject: "Status update", body: "We have updated GEM/2026/B/7429306 details.", shouldMatch: true, confidence: "MEDIUM" },
      { subject: "Other tender", body: "Tender details here.", shouldMatch: false, confidence: "NONE" }
    ]
  },
  {
    raw: "Tender Reference Number TS 1704 AAA Rabbit and Dog Conductor Tender ID 2026_PKVVC_499972_1",
    expectedTokens: ["TS 1704 AAA", "2026_PKVVC_499972_1"],
    emailsToTest: [
      { subject: "TS 1704 AAA Conductor Tender", body: "Details inside.", shouldMatch: true, confidence: "HIGH" },
      { subject: "Clarification required", body: "This is regarding Tender ID 2026_PKVVC_499972_1.", shouldMatch: true, confidence: "MEDIUM" }
    ]
  },
  {
    raw: "BESCOM/2026-27/IND0231",
    expectedTokens: ["BESCOM/2026-27/IND0231"],
    emailsToTest: [
      { subject: "BESCOM/2026-27/IND0231 Prebid meeting", body: "Meeting details...", shouldMatch: true, confidence: "HIGH" }
    ]
  },
  {
    raw: "JP/B862-000-XT-MR-0220/80",
    expectedTokens: ["JP/B862-000-XT-MR-0220/80"],
    emailsToTest: [
      { subject: "Revision in JP/B862-000-XT-MR-0220/80", body: "Body details...", shouldMatch: true, confidence: "HIGH" }
    ]
  },
  {
    raw: "Tender ID 929611 Tender Notice Number EPMPT-04/26-27",
    expectedTokens: ["929611", "EPMPT-04/26-27"],
    emailsToTest: [
      { subject: "Queries on EPMPT-04/26-27", body: "See body...", shouldMatch: true, confidence: "HIGH" },
      { subject: "Tender 929611 submission status", body: "Status ok.", shouldMatch: true, confidence: "HIGH" }
    ]
  },
  {
    raw: "Tender ID- 299435",
    expectedTokens: ["299435"],
    emailsToTest: [
      { subject: "Re: Tender 299435", body: "Hi, please check.", shouldMatch: true, confidence: "HIGH" }
    ]
  },
  {
    raw: "System Tender No. 129842 Tender Reference No. 30/PR/NBPDCL/2026",
    expectedTokens: ["129842", "30/PR/NBPDCL/2026"],
    emailsToTest: [
      { subject: "30/PR/NBPDCL/2026 - Security Deposit", body: "Body...", shouldMatch: true, confidence: "HIGH" },
      { subject: "Regarding Tender No 129842", body: "Attached details.", shouldMatch: true, confidence: "HIGH" }
    ]
  },
  {
    raw: "Tender Reference Number 01/XEN/P-III/MM/QH-II/2136 dated 09.05.26 Tender ID 2026_HBC_520685_1",
    expectedTokens: ["01/XEN/P-III/MM/QH-II/2136", "2026_HBC_520685_1"],
    emailsToTest: [
      { subject: "01/XEN/P-III/MM/QH-II/2136 Amendment", body: "Details...", shouldMatch: true, confidence: "HIGH" },
      { subject: "Bid security 2026_HBC_520685_1", body: "Info...", shouldMatch: true, confidence: "HIGH" }
    ]
  }
];

let failed = 0;
let passed = 0;

console.log("=== RUNNING TENDER ID PARSING & EMAIL MATCHING TESTS ===\n");

testCases.forEach((tc, index) => {
  console.log(`Test Case #${index + 1}`);
  console.log(`Raw Tender Input: "${tc.raw}"`);
  
  const tokens = extractTenderTokens(tc.raw);
  console.log(`Extracted Tokens: ${JSON.stringify(tokens)}`);
  
  // Verify that tokens match expected tokens
  const tokenSet = new Set(tokens);
  const missingTokens = tc.expectedTokens.filter(et => !tokenSet.has(et));
  if (missingTokens.length > 0) {
    console.error(`❌ Token Extraction Fail! Missing tokens: ${JSON.stringify(missingTokens)}`);
    failed++;
  } else {
    console.log(`✅ Token Extraction Passed.`);
    passed++;
  }
  
  tc.emailsToTest.forEach((email, eIndex) => {
    const matchResult = checkMatch(tokens, email.subject, email.body);
    const success = (matchResult.matched === email.shouldMatch) && 
                    (!email.shouldMatch || matchResult.confidence === email.confidence);
    
    if (success) {
      console.log(`  └─ Email #${eIndex + 1} match validation passed (Matched: ${matchResult.matched}, Confidence: ${matchResult.confidence})`);
      passed++;
    } else {
      console.error(`  └─ ❌ Email #${eIndex + 1} match validation FAILED!`);
      console.error(`     Subject: "${email.subject}"`);
      console.error(`     Expected Match: ${email.shouldMatch} (${email.confidence}), Got Match: ${matchResult.matched} (${matchResult.confidence})`);
      failed++;
    }
  });
  console.log("");
});

console.log(`=== TEST SUMMARY ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed successfully! 🎉");
  process.exit(0);
}
