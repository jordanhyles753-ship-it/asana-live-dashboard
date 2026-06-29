// k4_users_final.js — login, select school, then fetch users via SOAP
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');

const K4_BASE = 'https://accelerated-abeka-v16-k4.fluxcloud.us:8443/K4ServerABEKA';
const PUB_IDS = ['1591015400393', '1626976338631', '1666130694400', '1683548304273'];

async function soapPost(session, service, action, bodyXml) {
  const ns = 'http://www.vjoon.com/ps/core/user/wstypes/';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wt="${ns}"><soapenv:Header/><soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;
  return new Promise((resolve, reject) => {
    const url = new URL(`${K4_BASE}/services/${service}`);
    const postData = Buffer.from(envelope, 'utf8');
    const opts = {
      hostname: url.hostname, port: parseInt(url.port) || 8443,
      path: url.pathname, method: 'POST', rejectUnauthorized: false,
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': action,
        'Cookie': `JSESSIONID=${session}`, 'Content-Length': postData.length,
        'Origin': 'https://accelerated-abeka-v16-k4.fluxcloud.us',
        'Referer': `${K4_BASE}/admin/`,
      }
    };
    let data = '';
    const req = https.request(opts, res => { res.on('data', d => data += d); res.on('end', () => resolve(data)); });
    req.on('error', reject);
    req.write(postData); req.end();
  });
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new', ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  // Phase 1: Get to K4 admin and do initial login
  console.log('Loading K4 admin...');
  await page.goto(`${K4_BASE}/admin/`, { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000));

  // Fill in the initial login dialog if present
  const initPass = await page.$('input.gwt-PasswordTextBox');
  if (initPass) {
    const initUser = await page.$('input.gwt-TextBox');
    await initUser.click({ clickCount: 3 }); await initUser.type('jordan jones');
    await initPass.click({ clickCount: 3 }); await initPass.type('Minnesota58!');
    await initPass.press('Enter');
    console.log('Initial credentials submitted, waiting...');
    await new Promise(r => setTimeout(r, 8000));
  }

  // Handle "logout existing session" button if appears
  const logoutBtn = await page.$('.logout.active');
  if (logoutBtn) {
    console.log('Alt-clicking logout button...');
    await page.keyboard.down('Alt');
    await logoutBtn.click();
    await page.keyboard.up('Alt');
    await new Promise(r => setTimeout(r, 3000));
    page.on('dialog', async d => { console.log('Dialog:', d.message()); await d.accept(); });
    await new Promise(r => setTimeout(r, 2000));
  }

  await page.screenshot({ path: '/tmp/u1.png' });

  // Phase 2: School grid is now visible. Find and click "Abeka High School" row
  console.log('Looking for Abeka High School row...');
  const schoolClicked = await page.evaluate(() => {
    // Find element containing exactly "Abeka High School"
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === 'Abeka High School') {
        const el = node.parentElement;
        el.click();
        return 'Found and clicked: ' + el.outerHTML.substring(0, 100);
      }
    }
    return null;
  });
  console.log('School click result:', schoolClicked);
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: '/tmp/u2.png' });

  // Phase 3: Click the gold "Log In" key button in toolbar
  const loginBtnClicked = await page.evaluate(() => {
    const btn = document.querySelector('div.login.active');
    if (btn) { btn.click(); return 'Clicked div.login.active'; }
    return null;
  });
  console.log('Login button:', loginBtnClicked);
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/u3.png' });

  // Phase 4: Fill the school-specific login dialog
  try {
    await page.waitForSelector('input.gwt-PasswordTextBox', { timeout: 6000 });
    const uField = await page.$('input.gwt-TextBox');
    const pField = await page.$('input.gwt-PasswordTextBox');
    if (uField && pField) {
      await uField.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await uField.type('jordan jones');
      await pField.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await pField.type('Minnesota58!');
      await pField.press('Enter');
      console.log('School login credentials submitted');
      await new Promise(r => setTimeout(r, 7000));
    }
  } catch(e) {
    console.log('No credential dialog appeared:', e.message);
  }

  await page.screenshot({ path: '/tmp/u4.png' });

  // Get the session cookie
  const cookies = await page.cookies();
  const jsession = cookies.find(c => c.name === 'JSESSIONID')?.value;
  console.log('Session:', jsession ? jsession.substring(0, 30) + '...' : 'NOT FOUND');

  // Also try to verify session by checking page state
  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Page state:', pageText.substring(0, 200));

  await browser.close();

  if (!jsession) { console.error('No session'); process.exit(1); }

  // Phase 5: Use session to fetch users from each publication
  console.log('\nFetching users...');
  const USER_NS = 'http://www.vjoon.com/ps/core/user/wstypes/';
  const userMap = {};

  for (const pubId of PUB_IDS) {
    console.log(`\nPub ${pubId}:`);
    const xml = await soapPost(
      jsession, 'UserBasic',
      'http://www.vjoon.com/k4/user/basic/getUsersByPublicationID1',
      `<wt:getUsersByPublicationID1Request xmlns:wt="${USER_NS}"><wt:publicationID>${pubId}</wt:publicationID></wt:getUsersByPublicationID1Request>`
    );

    if (xml.includes('not logged in') || xml.includes('errorCode>51')) {
      console.log('  -> Not logged in'); continue;
    }
    if (xml.includes('<faultstring')) {
      console.log('  -> Fault:', xml.match(/<faultstring[^>]*>([^<]+)/)?.[1]?.substring(0, 80));
      continue;
    }

    // Parse user data from XML
    // Try block-based extraction first
    const userBlocks = [...xml.matchAll(/<(?:ns\d+:)?user[^s>][^>]*>([\s\S]*?)<\/(?:ns\d+:)?user>/g)];
    console.log(`  ${userBlocks.length} user blocks found`);
    for (const [, b] of userBlocks) {
      const ex = tag => b.match(new RegExp(`<(?:ns\\d+:)?${tag}[^>]*>([^<]+)`))?.[1]?.trim();
      const id = ex('userID') || ex('id');
      const name = ex('displayName') || [ex('firstName'), ex('lastName')].filter(Boolean).join(' ') || ex('loginName');
      if (id && name) userMap[id] = name;
    }

    // Flat extraction fallback
    if (userBlocks.length === 0) {
      const ids = [...xml.matchAll(/<(?:ns\d+:)?userID[^>]*>(\d+)/g)].map(m => m[1]);
      const firsts = [...xml.matchAll(/<(?:ns\d+:)?firstName[^>]*>([^<]+)/g)].map(m => m[1].trim());
      const lasts = [...xml.matchAll(/<(?:ns\d+:)?lastName[^>]*>([^<]+)/g)].map(m => m[1].trim());
      console.log(`  Flat: ${ids.length} userIDs`);
      for (let i = 0; i < ids.length; i++) {
        const name = [firsts[i], lasts[i]].filter(Boolean).join(' ');
        if (name) userMap[ids[i]] = name;
      }
      if (ids.length === 0) {
        // Show raw XML to debug
        console.log('  Raw XML (first 800):', xml.substring(0, 800));
      }
    }
  }

  const targetIds = ['567720','17889230','400086','821','31109327','815','567402','627301','2517834','783205','804','827','27703265','157317','783161','17524336'];
  console.log('\n=== Target ID Results ===');
  targetIds.forEach(id => console.log(`  ${id} -> ${userMap[id] || 'NOT FOUND'}`));
  console.log(`\nTotal users resolved: ${Object.keys(userMap).length}`);

  fs.writeFileSync('k4_users.json', JSON.stringify(userMap, null, 2));
  console.log('Saved to k4_users.json');
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
