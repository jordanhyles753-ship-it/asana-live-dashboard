const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const K4_BASE = 'https://accelerated-abeka-v16-k4.fluxcloud.us:8443/K4ServerABEKA';
const WF_NS = 'http://www.vjoon.com/ps/core/workflow/wstypes/';
const QY_NS = 'http://www.vjoon.com/ps/core/query/wstypes/';
const ALL_PUB_IDS = ['1591015400393', '1626976338631', '1666130694400', '1683548304273'];

const DUMP_PATH = path.join(__dirname, 'k4_dump.json');

async function k4Soap(session, service, soapAction, bodyXml, nsOverride) {
  const ns = nsOverride || QY_NS;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wt="${ns}">
  <soapenv:Header/>
  <soapenv:Body>${bodyXml}</soapenv:Body>
</soapenv:Envelope>`;
  const r = await fetch(`${K4_BASE}/services/${service}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'SOAPAction': soapAction,
      'Cookie': `JSESSIONID=${session}`,
      'Origin': 'https://accelerated-abeka-v16-k4.fluxcloud.us',
      'Referer': `${K4_BASE}/admin/`,
    },
    body: envelope,
  });
  return r.text();
}

async function loginAndGetSession(schoolRegex) {
  console.log(`Launching browser, logging in to K4 Admin looking for school matching ${schoolRegex}...`);
  const browser = await puppeteer.launch({ headless: 'new', ignoreHTTPSErrors: true });
  const page = await browser.newPage();

  await page.goto(`${K4_BASE}/admin/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input.gwt-TextBox', { timeout: 20000 });

  const textInputs = await page.$$('input.gwt-TextBox');
  const passInputs = await page.$$('input.gwt-PasswordTextBox');
  await textInputs[0].type('jordan jones');
  await passInputs[0].type('Minnesota58!');
  await passInputs[0].press('Enter');
  await new Promise(r => setTimeout(r, 5000));

  // Force logout any existing session
  const logoutBtn = await page.$('.logout.active');
  if (logoutBtn) {
    await page.keyboard.down('Alt');
    await logoutBtn.click();
    await page.keyboard.up('Alt');
    await new Promise(r => setTimeout(r, 3000));
    page.on('dialog', async d => { await d.accept(); });
  }

  // List all schools
  const elements = await page.$$('.simplegrid-scroller-column-text');
  const allSchools = [];
  for (const el of elements) {
    const text = await page.evaluate(e => e.textContent.trim(), el);
    if (text) allSchools.push({ el, text });
  }
  console.log('Available schools:', allSchools.map(s => s.text).join(', '));

  const targetSchool = allSchools.find(s => schoolRegex.test(s.text));
  if (!targetSchool) {
    console.error(`Could not find school matching regex. Available: ${allSchools.map(s => s.text)}`);
    await browser.close();
    return null;
  }
  
  console.log(`Clicking: "${targetSchool.text}"`);
  await targetSchool.el.click();

  await new Promise(r => setTimeout(r, 1000));
  await page.click('div.login.active');
  await new Promise(r => setTimeout(r, 2000));

  await page.waitForSelector('.md-window input.gwt-TextBox', { timeout: 10000 });
  const userInput = await page.$('.md-window input.gwt-TextBox');
  await userInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await userInput.type('jordan jones');
  const passInput = await page.$('.md-window input.gwt-PasswordTextBox');
  await passInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await passInput.type('Minnesota58!');
  await passInput.press('Enter');
  await new Promise(r => setTimeout(r, 5000));

  const cookies = await page.cookies();
  const jsession = cookies.find(c => c.name === 'JSESSIONID')?.value;
  await browser.close();

  if (!jsession) {
    console.error('Failed to get JSESSIONID from login');
    return null;
  }
  console.log('SUCCESS! Session:', jsession);
  return jsession;
}

async function fetchArticlesForSession(session) {
  // Build status map
  console.log('Fetching status definitions...');
  const statusMap = {};
  for (const pubId of ALL_PUB_IDS) {
    try {
      const xml = await k4Soap(session, 'WorkflowBasic',
        'http://www.vjoon.com/k4/workflow/basic/getStatusesByPublicationID1',
        `<wt:getStatusesByPublicationID1Request xmlns:wt="${WF_NS}">
           <wt:publicationID>${pubId}</wt:publicationID>
         </wt:getStatusesByPublicationID1Request>`, WF_NS);
      const ids   = [...xml.matchAll(/<ns10:id[^>]*>(\d+)/g)].map(m => m[1]);
      const names = [...xml.matchAll(/<ns10:name[^>]*>([^<]+)/g)].map(m => m[1].trim());
      for (let i = 0; i < ids.length; i++) statusMap[ids[i]] = names[i];
    } catch(e) {}
  }
  console.log(`Loaded ${Object.keys(statusMap).length} status definitions`);

  // Fetch all articles from all pubs
  const allArticles = [];
  for (const pubId of ALL_PUB_IDS) {
    console.log(`Fetching queries for pub ${pubId}...`);
    const qxml = await k4Soap(session, 'QueryBasic',
      'http://www.vjoon.com/ps/core/query/basic/getQueriesByPublicationID1',
      `<wt:getQueriesByPublicationID1Request xmlns:wt="${QY_NS}">
         <wt:publicationID>${pubId}</wt:publicationID>
       </wt:getQueriesByPublicationID1Request>`, QY_NS);

    const fault = qxml.match(/<faultstring[^>]*>([^<]+)/)?.[1];
    if (fault) {
      console.log(`  FAULT: ${fault.slice(0,80)}`);
      continue;
    }

    const queryIds = [];
    for (const m of qxml.matchAll(/<[^:]*:query[^>]*>([\s\S]*?)<\/[^:]*:query>/g)) {
      const id = m[1].match(/<[^:]*:id[^>]*>(\d+)/)?.[1];
      if (id) queryIds.push(id);
    }
    console.log(`  Found ${queryIds.length} queries`);

    for (const qid of queryIds) {
      const xml = await k4Soap(session, 'QueryBasic',
        'http://www.vjoon.com/ps/core/query/service/getQueryObjects1',
        `<wt:getQueryObjects1Request xmlns:wt="${QY_NS}">
           <wt:publicationId>${pubId}</wt:publicationId>
           <wt:queryId>${qid}</wt:queryId>
           <wt:queryFilter xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
           <wt:fullTextSearchQuery></wt:fullTextSearchQuery>
           <wt:withCollections>false</wt:withCollections>
           <wt:withDamObjects>false</wt:withDamObjects>
           <wt:withMetaData>1</wt:withMetaData>
           <wt:maxNumberReturnObjects>5000</wt:maxNumberReturnObjects>
         </wt:getQueryObjects1Request>`, QY_NS);

      for (const m of xml.matchAll(/<wfObjectVariant1Items[^>]*>([\s\S]*?)<\/wfObjectVariant1Items>/g)) {
        const k4ObjectID = m[1].match(/<ns\d+:k4ObjectID[^>]*>(\d+)/)?.[1];
        if (k4ObjectID && allArticles.some(a => a.id === k4ObjectID)) continue;
        const objectName = m[1].match(/<ns\d+:objectName[^>]*>([^<]+)/)?.[1];
        const statusID   = m[1].match(/<ns\d+:statusID[^>]*>(\d+)/)?.[1];
        const dateTime   = m[1].match(/<ns\d+:fileVersionDateTime[^>]*>([^<]+)/)?.[1];
        if (objectName && statusID) {
          const code = objectName.match(/(\d{5,10})/)?.[1] || null;
          allArticles.push({
            id: k4ObjectID,
            name: objectName,
            code,
            workflowStep: statusMap[statusID] || statusID,
            lastModified: dateTime || '',
            publicationID: pubId,
          });
        }
      }
    }
  }

  console.log(`Total articles fetched in this session: ${allArticles.length}`);
  return allArticles;
}

async function run() {
  console.log('=== STARTING K4 SYNC ===');
  
  // We'll log into BOTH Elementary and High School just to be absolutely sure we get everything.
  // Based on prior logs, High School actually gives access to 438049 articles, but we'll merge everything.
  
  const allArticles = [];

  const highSchoolSession = await loginAndGetSession(/high\s*school/i);
  if (highSchoolSession) {
    const hsArticles = await fetchArticlesForSession(highSchoolSession);
    allArticles.push(...hsArticles);
  }

  const elementarySession = await loginAndGetSession(/elementary/i);
  if (elementarySession) {
    const elemArticles = await fetchArticlesForSession(elementarySession);
    for (const ea of elemArticles) {
      if (!allArticles.some(a => a.id === ea.id)) {
        allArticles.push(ea);
      }
    }
  }
  
  console.log(`Total unique articles across all sessions: ${allArticles.length}`);

  // Build k4Map
  const k4Map = {};
  for (const a of allArticles) {
    if (a.code && a.workflowStep !== 'Trash' && !a.name.toUpperCase().includes('TRASH')) {
      if (!k4Map[a.code]) k4Map[a.code] = [];
      // Prevent duplicates in the array for the same code
      if (!k4Map[a.code].some(existing => existing.id === a.id)) {
         k4Map[a.code].push(a);
      }
    }
  }

  let existingDump = {};
  try {
    if (fs.existsSync(DUMP_PATH)) {
      existingDump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
    }
  } catch(e) {
    console.error('Could not read existing dump, starting fresh', e);
  }

  let merged = 0;
  for (const [code, arts] of Object.entries(k4Map)) {
    if (!existingDump[code]) {
      arts.forEach(a => { a.transitionDate = a.lastModified || new Date().toISOString(); });
      existingDump[code] = arts;
      merged += arts.length;
    } else {
      // Add any new articles not already in dump, and UPDATE existing ones
      for (const a of arts) {
        const existingIdx = existingDump[code].findIndex(e => e.id === a.id);
        if (existingIdx === -1) {
          // New article - baseline transition date is its last file modification date
          a.transitionDate = a.lastModified || new Date().toISOString();
          existingDump[code].push(a);
          merged++;
        } else {
          const oldArticle = existingDump[code][existingIdx];
          if (oldArticle.workflowStep !== a.workflowStep) {
            // Status changed! Record the exact time of sync as the transition date
            a.transitionDate = new Date().toISOString();
          } else {
            // Status unchanged. Retain transition date, or fallback to file modification baseline
            a.transitionDate = oldArticle.transitionDate || oldArticle.lastModified || a.lastModified;
          }
          existingDump[code][existingIdx] = a; // update with latest status
        }
      }
    }
  }

  console.log(`Merged/Updated ${merged} articles into k4_dump.json`);
  console.log(`Total codes in dump: ${Object.keys(existingDump).length}`);
  fs.writeFileSync(DUMP_PATH, JSON.stringify(existingDump, null, 2));
  console.log('DONE! k4_dump.json updated.');
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
