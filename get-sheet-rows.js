const fs = require('fs');
const path = require('path');

const cachePath = path.join(__dirname, 'data', 'sync_cache.json');
if (!fs.existsSync(cachePath)) {
  console.log("No cache found.");
  process.exit(0);
}

const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

console.log("Searching for row 2818 (GEM/2026/B/7575937):");
const row2818 = cache.tenders.find(t => t.rowNumber === 2818);
if (row2818) {
  console.log(JSON.stringify(row2818, null, 2));
} else {
  console.log("Row 2818 not found. Finding by 7575937...");
  const t1 = cache.tenders.find(t => t.tenderNoRaw && t.tenderNoRaw.includes('7575937'));
  console.log(JSON.stringify(t1, null, 2));
}

console.log("\nSearching for row 2690 (2026_JSEB_113070_1):");
const row2690 = cache.tenders.find(t => t.rowNumber === 2690);
if (row2690) {
  console.log(JSON.stringify(row2690, null, 2));
} else {
  console.log("Row 2690 not found. Finding by 113070...");
  const t2 = cache.tenders.find(t => t.tenderNoRaw && t.tenderNoRaw.includes('113070'));
  console.log(JSON.stringify(t2, null, 2));
}
