const xlsx = require('xlsx');
const fs = require('fs');

console.log('Reading data.xlsx...');
const workbook = xlsx.readFile('data.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });

function excelDateToISO(excelDateStr) {
  const serial = parseFloat(excelDateStr);
  if (isNaN(serial)) return null;
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const msPerDay = 24 * 60 * 60 * 1000;
  return new Date(excelEpoch.getTime() + serial * msPerDay).toISOString();
}

// Map of object_name -> max FINISH_TASK date
const historyMap = {};
for (const row of data) {
  if (row.event_type === 'FINISH_TASK' && row.object_name) {
    const timeSerial = parseFloat(row.event_time);
    if (!isNaN(timeSerial)) {
      if (!historyMap[row.object_name] || timeSerial > historyMap[row.object_name]) {
        historyMap[row.object_name] = timeSerial;
      }
    }
  }
}

console.log(`Found historical transition dates for ${Object.keys(historyMap).length} unique article names.`);

const dumpPath = 'k4_dump.json';
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

let backfillCount = 0;

for (const code in dump) {
  const articles = dump[code];
  for (const art of articles) {
    // Try exact match first
    let matchedName = null;
    if (historyMap[art.name]) {
      matchedName = art.name;
    } else {
      // Try prefix match (in case K4 name has _View-revoked suffix)
      for (const excelName of Object.keys(historyMap)) {
        if (art.name.startsWith(excelName)) {
          matchedName = excelName;
          break;
        }
      }
    }

    if (matchedName) {
      const isoDate = excelDateToISO(historyMap[matchedName]);
      if (isoDate) {
        art.transitionDate = isoDate;
        backfillCount++;
      }
    }
  }
}

console.log(`Successfully backfilled transitionDate for ${backfillCount} articles.`);
fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
console.log('Saved k4_dump.json.');
