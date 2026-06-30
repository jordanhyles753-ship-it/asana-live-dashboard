#!/usr/bin/env node
/**
 * K4 → Asana Status Sync
 *
 * Usage:
 *   node sync.js                    # dry run (needs fresh JSESSIONID if <100 K4 issues returned)
 *   node sync.js --apply            # writes to Asana
 *   node sync.js --explore          # dumps raw K4 XML + sample issues
 *   node sync.js --explore-workflow # probes WorkflowBasic for per-object status
 *   node sync.js --dump-wsdl        # dumps full WorkflowBasic + PublicationBasic WSDLs
 */

const DRY_RUN     = !process.argv.includes('--apply');
const EXPLORE     = process.argv.includes('--explore');
const EXPLORE_WF  = process.argv.includes('--explore-workflow');
const DUMP_WSDL   = process.argv.includes('--dump-wsdl');

// ── Credentials ──────────────────────────────────────────────────────────────
// Session expires periodically. If <100 K4 issues return, get a fresh one:
//   Chrome DevTools (F12) → Application → Cookies → copy JSESSIONID
require('dotenv').config();
const puppeteer = require('puppeteer');
const K4_BASE      = 'https://accelerated-abeka-v16-k4.fluxcloud.us:8443/K4ServerABEKA';
const ASANA_TOKEN  = process.env.ASANA_TOKEN;
let K4_SESSION     = '';
const KANBAN_TOKEN = 'Q24379ZMV5ZS3LXM';
const ASANA_WS     = '1123446613688331';

// Provide a mapping of K4 User IDs to real names (since K4 API blocks querying names)
const K4_USER_MAP = {
  // "1321802": "Dani Becerra",
};
const K4_PUB_IDS   = ['1591015400393', '1626976338631', '1666130694400', '1683548304273'];

// ── Workflow step order ───────────────────────────────────────────────────────
// Uses K4's actual status names (channel 24535155 for full pilot workflow,
// channel 24533394 for non-pilot). "Proofing R1" etc are K4's abbreviations;
// norm() handles matching against Asana's "Proofing Round 1" variants.
const WORKFLOW_ORDER = [
  'Draft',
  'Manager Draft Review',
  'Draft Review',
  'Layout Creation',
  'Pilot Layout Review',
  'Pilot Round',
  'Layout Review',
  'Proofing R1',
  'Editorial Round Final',
  'Pre-Apogee Proof R1',
  'Pre-Apogee Proof R2',
  'Apogee Proof',
  'Ready for Print Order',
  // Terminal / Done states in K4:
  'Ready to Route',
  'Route',
  'Print',
  'Copy Edit',
  'Final'
];

// Normalize: lowercase, collapse "Round N" / "R N" / "RN" → just the digit,
// then strip all non-alphanumeric so "Proofing R1" ≡ "Proofing Round 1".
// Also convert Asana's "Chapter N" to K4's "CH0N", "Front Matter" to "FM", "Back Matter" to "BM"
const norm = s => {
  let v = (s || '').toLowerCase()
    .replace(/\bround\s*(\d+)/g, '$1')   // "round 1" → "1", "round1" → "1"
    .replace(/\br(\d+)/g,        '$1')   // "r1" → "1", "r2" → "2"
    .replace(/front\s*matter/g,  'fm')
    .replace(/back\s*matter/g,   'bm')
    .replace(/chapter\s*/g,      'ch');
  
  v = v.replace(/[^a-z0-9]/g, '');
  
  // padding: ch1 -> ch01 to match K4
  v = v.replace(/ch(\d)(?!\d)/g, 'ch0$1');
  return v;
};

function matchesSection(k4Name, asanaSection) {
  const k4Norm = norm(k4Name);
  const secNorm = norm(asanaSection);
  if (k4Norm.includes(secNorm)) return true;
  
  const rangeMatch = asanaSection.match(/(?:lesson|l)s?\s*0*(\d+)\s*-\s*0*(\d+)/i);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const k4LMatch = k4Name.match(/(?:lesson|l)\s*0*(\d+)/i);
    if (k4LMatch) {
      const k4Num = parseInt(k4LMatch[1], 10);
      if (k4Num >= start && k4Num <= end) return true;
    }
  }
  
  const singleMatch = asanaSection.match(/(?:lesson|l)s?\s*0*(\d+)(?!\s*-)/i);
  if (singleMatch && !rangeMatch) {
    const num = parseInt(singleMatch[1], 10);
    const k4LMatch = k4Name.match(/(?:lesson|l)\s*0*(\d+)/i);
    if (k4LMatch && parseInt(k4LMatch[1], 10) === num) return true;
  }
  return false;
}

const WORKFLOW_NORM = WORKFLOW_ORDER.map(norm);

function deriveStatus(k4Step, asanaStep, kanbanBlocked, dueDate) {
  const k4Idx   = WORKFLOW_NORM.indexOf(norm(k4Step));
  const askIdx  = WORKFLOW_NORM.indexOf(norm(asanaStep));
  const today   = new Date().toISOString().slice(0, 10);
  const overdue = dueDate && dueDate < today;
  if (k4Idx === -1 || askIdx === -1) return null;
  if (askIdx < k4Idx)  return 'Complete';
  if (askIdx > k4Idx)  return null;
  if (kanbanBlocked)   return 'Off track';
  if (overdue)         return 'Off track';
  return 'On track';
}

const log  = (...a) => console.log('[sync]', ...a);
const info = (...a) => console.log(' ', ...a);
const warn = (...a) => console.warn('[WARN]', ...a);

// ── K4 SOAP helper ────────────────────────────────────────────────────────────
async function k4Soap(service, soapAction, bodyXml, nsOverride) {
  const ns = nsOverride || 'http://www.vjoon.com/ps/core/publication/wstypes/';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wt="${ns}">
  <soapenv:Header/>
  <soapenv:Body>${bodyXml}</soapenv:Body>
</soapenv:Envelope>`;

  const r = await fetch(`${K4_BASE}/services/${service}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'SOAPAction':   soapAction,
      'Cookie':       `JSESSIONID=${K4_SESSION}`,
      'Origin':       'https://accelerated-abeka-v16-k4.fluxcloud.us',
      'Referer':      `${K4_BASE}/admin/`,
    },
    body: envelope,
  });
  return r.text();
}

// ── Dump WSDLs ────────────────────────────────────────────────────────────────
async function dumpWsdl() {
  for (const svc of ['WorkflowBasic', 'PublicationBasic']) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  WSDL: ${svc}`);
    console.log('═'.repeat(60));
    const r = await fetch(`${K4_BASE}/services/${svc}?wsdl`, {
      headers: { Cookie: `JSESSIONID=${K4_SESSION}` },
    });
    console.log(`HTTP ${r.status}`);
    const text = await r.text();
    console.log(text);
  }
  process.exit(0);
}

// ── WorkflowBasic exploration ─────────────────────────────────────────────────
async function exploreWorkflow(sampleIssueId, pubId) {
  const WF_NS  = 'http://www.vjoon.com/ps/core/workflow/wstypes/';
  const WF_API = 'http://www.vjoon.com/ps/api/workflow/types/';
  const WF_SVC = 'WorkflowBasic';
  const WF_ACT = 'http://www.vjoon.com/k4/workflow/basic/';

  const dump = (label, xml, limit = 6000) => {
    const tags = [...new Set([...xml.matchAll(/<([a-zA-Z0-9:_-]+)[\s>]/g)].map(m => m[1]))]
      .filter(t => !t.startsWith('soapenv') && !t.startsWith('?xml'));
    const fault = xml.match(/<faultstring[^>]*>([^<]+)/)?.[1];
    console.log(`\n── ${label} ──`);
    if (fault) { console.log('  FAULT:', fault); return null; }
    console.log('Tags:', tags.join(', '));
    console.log(xml.slice(0, limit));
    return xml;
  };

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  WorkflowBasic EXPLORATION v3');
  console.log('  pubId:', pubId, '  issueId:', sampleIssueId);
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. Verify norm() matching ──────────────────────────────────────────────
  console.log('── 1. norm() check — K4 name vs Asana name equivalence ──');
  const checks = [
    ['Proofing R1', 'Proofing Round 1'],
    ['Pre-Apogee Proof R1', 'Pre-Apogee Proof Round 1'],
    ['Pre-Apogee Proof R2', 'Pre-Apogee Proof Round 2'],
    ['Ready for Print Order', 'Ready for Print Order'],
    ['Editorial Round Final', 'Editorial Round Final'],
  ];
  for (const [a, b] of checks) {
    const match = norm(a) === norm(b);
    console.log(`  "${a}" ≡ "${b}" → norm: ${norm(a)} | ${match ? '✅ match' : '❌ MISMATCH'}`);
  }

  // ── 2. Raw XML from getIssuesByPublicationID1 (diagnose 2-issues problem) ──
  console.log('\n── 2. Raw getIssuesByPublicationID1 response (first 2000 chars) ──');
  try {
    const xml = await k4Soap('PublicationBasic',
      'http://www.vjoon.com/k4/publication/basic/getIssuesByPublicationID1',
      `<wt:getIssuesByPublicationID1Request>
         <wt:publicationID>${pubId}</wt:publicationID>
       </wt:getIssuesByPublicationID1Request>`);
    const issueCount = (xml.match(/<(?:ns\d+:)?issue[^s>]/g) || []).length;
    console.log(`  Matched issue elements: ${issueCount}`);
    console.log(xml.slice(0, 2000));
  } catch (e) { console.log('  ERROR:', e.message); }

  // ── 3. getWFObjectVariantsByK4ObjectIDs1 — more element name variants ──────
  console.log('\n── 3. getWFObjectVariantsByK4ObjectIDs1 — additional variants ──');
  const newVariants = [
    {
      label: 'E: wt:k4ObjectID repeated (no list wrapper)',
      body: `<wt:getWFObjectVariantsByK4ObjectIDs1Request xmlns:wt="${WF_NS}">
         <wt:k4ObjectID>${sampleIssueId}</wt:k4ObjectID>
       </wt:getWFObjectVariantsByK4ObjectIDs1Request>`,
    },
    {
      label: 'F: k4ObjectID no namespace (no list wrapper)',
      body: `<wt:getWFObjectVariantsByK4ObjectIDs1Request xmlns:wt="${WF_NS}">
         <k4ObjectID>${sampleIssueId}</k4ObjectID>
       </wt:getWFObjectVariantsByK4ObjectIDs1Request>`,
    },
    {
      label: 'G: wt:objectID (abbreviated name)',
      body: `<wt:getWFObjectVariantsByK4ObjectIDs1Request xmlns:wt="${WF_NS}">
         <wt:objectID>${sampleIssueId}</wt:objectID>
       </wt:getWFObjectVariantsByK4ObjectIDs1Request>`,
    },
    {
      label: 'H: no-namespace wrapper + k4ObjectIDList',
      body: `<getWFObjectVariantsByK4ObjectIDs1Request>
         <k4ObjectIDList><k4ObjectID>${sampleIssueId}</k4ObjectID></k4ObjectIDList>
       </getWFObjectVariantsByK4ObjectIDs1Request>`,
    },
    {
      label: 'I: empty body (what does server require?)',
      body: `<wt:getWFObjectVariantsByK4ObjectIDs1Request xmlns:wt="${WF_NS}">
       </wt:getWFObjectVariantsByK4ObjectIDs1Request>`,
    },
  ];

  let successXml = null;
  for (const v of newVariants) {
    try {
      const xml = await k4Soap(WF_SVC, `${WF_ACT}getWFObjectVariantsByK4ObjectIDs1`, v.body, WF_NS);
      const fault = xml.match(/<faultstring[^>]*>([^<]+)/)?.[1];
      console.log(`  [${v.label}] → ${fault ? 'FAULT: ' + fault : 'SUCCESS'}`);
      if (!fault) {
        successXml = xml;
        console.log('  ', xml.slice(0, 2000));
        break;
      }
    } catch (e) { console.log(`  [${v.label}] → ERROR: ${e.message}`); }
  }

  // ── 4. Try same variants for getWFObjectVariantByID1 ─────────────────────
  console.log('\n── 4. getWFObjectVariantByID1 — additional variants ──');
  const id1variants = [
    {
      label: 'E: wt:variantID',
      body: `<wt:getWFObjectVariantByID1Request xmlns:wt="${WF_NS}">
         <wt:variantID>${sampleIssueId}</wt:variantID>
       </wt:getWFObjectVariantByID1Request>`,
    },
    {
      label: 'F: wt:objectVariantID',
      body: `<wt:getWFObjectVariantByID1Request xmlns:wt="${WF_NS}">
         <wt:objectVariantID>${sampleIssueId}</wt:objectVariantID>
       </wt:getWFObjectVariantByID1Request>`,
    },
    {
      label: 'G: empty body',
      body: `<wt:getWFObjectVariantByID1Request xmlns:wt="${WF_NS}">
       </wt:getWFObjectVariantByID1Request>`,
    },
  ];
  for (const v of id1variants) {
    try {
      const xml = await k4Soap(WF_SVC, `${WF_ACT}getWFObjectVariantByID1`, v.body, WF_NS);
      const fault = xml.match(/<faultstring[^>]*>([^<]+)/)?.[1];
      console.log(`  [${v.label}] → ${fault ? 'FAULT: ' + fault : 'SUCCESS'}`);
      if (!fault) { console.log(xml.slice(0, 1000)); break; }
    } catch (e) { console.log(`  [${v.label}] → ERROR: ${e.message}`); }
  }

  // ── 5. Try PublicationBasic with alternate article/layout methods ──────────
  console.log('\n── 5. PublicationBasic — exploring sub-issue object methods ──');
  const pubMethods = [
    'getLayoutsByIssueID1',
    'getArticlesByIssueID1',
    'getObjectsByIssueID1',
    'getDocumentsByIssueID1',
    'getContentByIssueID1',
    'getStorysByIssueID1',
    'getItemsByIssueID1',
  ];
  for (const method of pubMethods) {
    try {
      const xml = await k4Soap('PublicationBasic',
        `http://www.vjoon.com/k4/publication/basic/${method}`,
        `<wt:${method}Request xmlns:wt="http://www.vjoon.com/ps/core/publication/wstypes/">
           <wt:issueID>${sampleIssueId}</wt:issueID>
         </wt:${method}Request>`,
        'http://www.vjoon.com/ps/core/publication/wstypes/');
      const fault = xml.match(/<faultstring[^>]*>([^<]+)/)?.[1];
      const tags = fault ? [] : [...new Set([...xml.matchAll(/<([a-zA-Z0-9:_-]+)[\s>]/g)].map(m => m[1]))];
      console.log(`  ${method}: ${fault ? 'FAULT: ' + fault : 'OK — tags: ' + tags.slice(0,6).join(', ')}`);
      if (!fault && xml.includes('<')) console.log('  ', xml.slice(0, 600));
    } catch (e) { console.log(`  ${method}: ERROR: ${e.message}`); }
  }

  console.log('\n══════════════════════════════════════════════════════\n');
  process.exit(0);
}

// ── Get K4 issues ─────────────────────────────────────────────────────────────
async function getK4Issues(pubID) {
  const xml = await k4Soap(
    'PublicationBasic',
    'http://www.vjoon.com/k4/publication/basic/getIssuesByPublicationID1',
    `<wt:getIssuesByPublicationID1Request>
       <wt:publicationID>${pubID}</wt:publicationID>
     </wt:getIssuesByPublicationID1Request>`
  );

  if (EXPLORE) {
    console.log('\n=== RAW K4 XML (first 6000 chars) ===');
    console.log(xml.slice(0, 6000));
    const firstBlock = xml.match(/<(?:ns\d+:)?issue[^s>][^>]*>([\s\S]*?)<\/(?:ns\d+:)?issue>/);
    if (firstBlock) {
      console.log('\n=== FIRST ISSUE BLOCK (complete) ===');
      console.log(firstBlock[0]);
    }
    const allTags = [...new Set([...xml.matchAll(/<([a-zA-Z0-9:]+)[^/\s>]/g)].map(m => m[1]))];
    console.log('\nALL XML tags in entire response:', allTags.join(', '));
    console.log('=== END ===\n');
  }

  if (xml.includes('errorCode>51') || xml.includes('session expired')) {
    throw new Error('K4 session expired — paste a new JSESSIONID from Chrome DevTools');
  }
  if (xml.includes('<faultstring')) {
    const msg = xml.match(/<faultstring[^>]*>([^<]+)/)?.[1] || 'SOAP fault';
    throw new Error(`K4 SOAP fault: ${msg}`);
  }

  const issues = [];
  const issueBlocks = [...xml.matchAll(/<(?:ns\d+:)?issue[^s>][^>]*>([\s\S]*?)<\/(?:ns\d+:)?issue>/g)];

  for (const block of issueBlocks) {
    const b = block[1];
    const extract = tag => {
      const m = b.match(new RegExp(`<(?:ns\\d+:)?${tag}[^>]*>([^<]+)<`, 'i'));
      return m ? m[1].trim() : null;
    };
    const name = extract('name');
    const id   = extract('id');
    const workflowStep =
      extract('workflowStepName') || extract('workflowstepname') ||
      extract('workflowStep')     || extract('workflow_step')    ||
      extract('stepName')         || extract('step')             ||
      extract('taskName')         || extract('task')             ||
      extract('statusName')       || extract('currentStep')      ||
      extract('currentTask')      || extract('status');
    const code = (name || '').match(/^(\d{5,10})/)?.[1] || null;
    if (id) issues.push({ id, name, code, workflowStep, publicationID: pubID });
  }

  if (issues.length === 0) {
    const names = [...xml.matchAll(/<(?:ns\d+:)?name[^>]*>([^<]+)</g)].map(m => m[1].trim());
    const ids   = [...xml.matchAll(/<(?:ns\d+:)?id[^>]*>(\d+)</g)].map(m => m[1]);
    const steps = [...xml.matchAll(/<(?:ns\d+:)?workflowStep[^>]*>([^<]+)</gi)].map(m => m[1].trim());
    for (let i = 0; i < ids.length; i++) {
      const name = names[i] || '';
      const code = name.match(/^(\d{5,10})/)?.[1] || null;
      issues.push({ id: ids[i], name, code, workflowStep: steps[i] || null, publicationID: pubID });
    }
  }

  if (issues.length < 50) {
    warn(`Only ${issues.length} issues for pub ${pubID} — session likely expired.`);
    warn('→ Chrome DevTools → Application → Cookies → copy JSESSIONID → update K4_SESSION in sync.js');
  }

  return issues;
}

// ── Get K4 workflow step per article ──────────────────────────────────────────
async function enrichWithWorkflowSteps() {
  const WF_NS  = 'http://www.vjoon.com/ps/core/workflow/wstypes/';
  const QY_NS  = 'http://www.vjoon.com/ps/core/query/wstypes/';

  // Build statusID → name map
  const statusMap = {};
  try {
    for (const pubId of K4_PUB_IDS) {
      const xml = await k4Soap('WorkflowBasic',
        'http://www.vjoon.com/k4/workflow/basic/getStatusesByPublicationID1',
        `<wt:getStatusesByPublicationID1Request xmlns:wt="${WF_NS}">
           <wt:publicationID>${pubId}</wt:publicationID>
         </wt:getStatusesByPublicationID1Request>`, WF_NS);
      const ids   = [...xml.matchAll(/<ns10:id[^>]*>(\d+)/g)].map(m => m[1]);
      const names = [...xml.matchAll(/<ns10:name[^>]*>([^<]+)/g)].map(m => m[1].trim());
      for (let i = 0; i < ids.length; i++) statusMap[ids[i]] = names[i];
    }
    log(`  Loaded ${Object.keys(statusMap).length} K4 status definitions`);
  } catch (e) {
    warn('Could not load K4 statuses:', e.message);
  }

  const allArticles = [];
  try {
    for (const pubId of K4_PUB_IDS) {
      // Find ALL queries
      const qxml = await k4Soap('QueryBasic',
        'http://www.vjoon.com/ps/core/query/basic/getQueriesByPublicationID1',
        `<wt:getQueriesByPublicationID1Request xmlns:wt="${QY_NS}">
           <wt:publicationID>${pubId}</wt:publicationID>
         </wt:getQueriesByPublicationID1Request>`, QY_NS);
         
      const queryIds = [];
      for (const m of qxml.matchAll(/<ns\d+:query[^>]*>([\s\S]*?)<\/ns\d+:query>/g)) {
         const id = m[1].match(/<ns\d+:id[^>]*>(\d+)/)?.[1];
         if (id) queryIds.push(id);
      }
      
      if (queryIds.length === 0) {
         warn(`Could not find any queries for pub ${pubId}`);
         continue;
      }
      // Fetch articles for all queries
      for (const qid of queryIds) {
          const xml = await k4Soap('QueryBasic',
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
             if (k4ObjectID && allArticles.some(a => a.id === k4ObjectID)) continue; // deduplicate
             
             const objectName = m[1].match(/<ns\d+:objectName[^>]*>([^<]+)/)?.[1];
             const statusID = m[1].match(/<ns\d+:statusID[^>]*>(\d+)/)?.[1];
             const fileVersionDateTime = m[1].match(/<ns\d+:fileVersionDateTime[^>]*>([^<]+)/)?.[1];
             const fileVersionUserID = m[1].match(/<ns\d+:fileVersionUserID[^>]*>(\d+)/)?.[1] || null;
             if (objectName && statusID) {
                const code = objectName.match(/^.*?(\d{5,10})/)?.[1] || null;
                allArticles.push({ 
                   id: k4ObjectID,
                   name: objectName, 
                   code, 
                   workflowStep: statusMap[statusID] || statusID,
                   publicationID: pubId,
                   lastModified: fileVersionDateTime,
                   assignedUserID: fileVersionUserID
                });
             }
          }
      }
    }
  } catch (e) {
    warn('Could not load K4 articles:', e.message);
  }

  return allArticles;
}

// ── Kanban ────────────────────────────────────────────────────────────────────
async function getKanbanBoards() {
  const r = await fetch('https://kanban.abeka.com/api/v1/boards?per_page=300', {
    headers: { Authorization: `Bearer ${KANBAN_TOKEN}`, Accept: 'application/xml' },
  });
  if (!r.ok) throw new Error(`Kanban API ${r.status}`);
  const xml = await r.text();
  const boards = {};
  for (const m of xml.matchAll(/<board>([\s\S]*?)<\/board>/g)) {
    const b    = m[1];
    const name = b.match(/<name[^>]*>(.*?)<\/name>/)?.[1]?.trim() || '';
    const id   = b.match(/<id[^>]*>(\d+)<\/id>/)?.[1] || '';
    const code = name.match(/^(\d{5,10})/)?.[1];
    if (!code) continue;
    const blocked = parseInt(b.match(/<blocked[^>]*>(\d+)/)?.[1] || '0', 10);
    boards[code] = { id, name, blocked };
  }
  return boards;
}

async function getKanbanTasks(boardId) {
  try {
    const r = await fetch(`https://kanban.abeka.com/api/v1/boards/${boardId}/tasks.json`, {
      headers: { Authorization: `Bearer ${KANBAN_TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}

// ── Asana ─────────────────────────────────────────────────────────────────────
async function asanaGet(path) {
  const r = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Asana GET ${path} → ${r.status}: ${await r.text()}`);
  return (await r.json()).data;
}

async function asanaPatch(taskGid, fields) {
  if (DRY_RUN) return null;
  const r = await fetch(`https://app.asana.com/api/1.0/tasks/${taskGid}`, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data: fields }),
  });
  if (!r.ok) throw new Error(`Asana PATCH ${taskGid} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getAsanaProjects() {
  const projects = await asanaGet(
    `/projects?workspace=${ASANA_WS}&limit=100&opt_fields=name,gid,custom_field_settings`
  );
  return projects.filter(p => /^\d{5,10}/.test(p.name));
}

async function getAsanaFields(projectGid) {
  const settings = await asanaGet(
    `/projects/${projectGid}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.enum_options,custom_field.type`
  );
  let statusField = null;
  let dateFieldGid = null;
  let assignedToGid = null;
  let dateAcceptedGid = null;

  for (const s of settings) {
    const cf = s.custom_field;
    if (cf && /progress.?status/i.test(cf.name)) {
      const options = {};
      for (const opt of cf.enum_options || []) options[opt.name] = opt.gid;
      statusField = { fieldGid: cf.gid, options };
    }
    if (cf && /completed/i.test(cf.name) && cf.type === 'date') {
      dateFieldGid = cf.gid;
    }
    if (cf && /assigned to/i.test(cf.name)) {
      assignedToGid = cf.gid;
    }
    if (cf && /date task accepted/i.test(cf.name) && cf.type === 'date') {
      dateAcceptedGid = cf.gid;
    }
  }
  return { statusField, dateFieldGid, assignedToGid, dateAcceptedGid };
}

async function getProjectTasks(projectGid, fieldGid) {
  const sections = await asanaGet(`/projects/${projectGid}/sections?opt_fields=name,gid`);
  const result = [];
  for (const sec of sections) {
    const tasks = await asanaGet(
      `/sections/${sec.gid}/tasks?opt_fields=name,gid,due_on,completed,completed_at,custom_fields&limit=100`
    );
    for (const task of tasks) {
      const cf = (task.custom_fields || []).find(f => f.gid === fieldGid);
      result.push({
        gid: task.gid, name: task.name, section: sec.name,
        dueOn: task.due_on, completed: task.completed,
        completedAt: task.completed_at,
        currentStatus: cf?.enum_value?.name || null,
        statusFieldGid: fieldGid,
        custom_fields: task.custom_fields || []
      });
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function authenticateK4(schoolRegex) {
  log(`Launching headless browser to auto-login to K4 for school ${schoolRegex}...`);
  const browser = await puppeteer.launch({ headless: "new", ignoreHTTPSErrors: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  await page.goto(`${K4_BASE}/admin/`, { waitUntil: 'networkidle2' });
  
  await page.waitForSelector('input.gwt-TextBox');
  await new Promise(r => setTimeout(r, 2000)); // allow modal to animate
  const textInputs = await page.$$('input.gwt-TextBox');
  const passInputs = await page.$$('input.gwt-PasswordTextBox');
  
  let resultSession = null;
  if (textInputs.length > 0 && passInputs.length > 0) {
      log('Typing credentials...');
      await textInputs[0].click({clickCount: 3});
      await page.keyboard.press('Backspace');
      await textInputs[0].type('jordan jones');
      
      await passInputs[0].click({clickCount: 3});
      await page.keyboard.press('Backspace');
      await passInputs[0].type('Minnesota58!');
      
      log('Authenticating...');
      await passInputs[0].press('Enter');
      
      await new Promise(r => setTimeout(r, 5000));
      
      // Force logging out removed, it was logging out of the current session
      
      const elements = await page.$$('.simplegrid-scroller-column-text');
      const allSchools = [];
      for (const el of elements) {
          const text = await page.evaluate(e => e.textContent, el);
          if (text) allSchools.push({ el, text });
      }
      
      const targetSchool = allSchools.find(s => schoolRegex.test(s.text));
      if (!targetSchool) {
          warn(`Could not find school matching ${schoolRegex}. Available: ${allSchools.map(s => s.text)}`);
      } else {
          log(`Clicking ${targetSchool.text}...`);
          await targetSchool.el.click();
          
          await new Promise(r => setTimeout(r, 1000));
          log('Clicking Log In (gold key)...');
          await page.click('div.login.active');
          await new Promise(r => setTimeout(r, 2000));
          
          log('Typing credentials into dialog...');
          await page.waitForSelector('.md-window input.gwt-TextBox');
          
          const userInput = await page.$('.md-window input.gwt-TextBox');
          await userInput.click({clickCount: 3});
          await page.keyboard.press('Backspace');
          await userInput.type('jordan jones');
          
          const passInput = await page.$('.md-window input.gwt-PasswordTextBox');
          await passInput.click({clickCount: 3});
          await page.keyboard.press('Backspace');
          await passInput.type('Minnesota58!');
          await passInput.press('Enter');
          
          await new Promise(r => setTimeout(r, 5000));
          
          const cookies = await page.cookies();
          const jsession = cookies.find(c => c.name === 'JSESSIONID')?.value;
          if (jsession) {
              log(`SUCCESS! Authenticated. JSESSIONID: ${jsession}`);
              resultSession = jsession;
          } else {
              log("FAILED to find JSESSIONID in cookies.");
          }
      }
  }
  
  await browser.close();
  return resultSession;
}

async function main() {
  if (EXPLORE_WF) return exploreWorkflow('15886', '2'); // Using dummy IDs just to execute it if needed, or extract logic.
  if (DUMP_WSDL) return await dumpWsdl();

  log(`[sync] ${DRY_RUN ? '🔍 DRY RUN — no changes will be written to Asana' : '🚀 APPLY MODE — writing to Asana'}`);
  log('');

  const allArticles = [];

  // 1. Fetch High School Articles
  log('--- FETCHING HIGH SCHOOL PUBS ---');
  K4_SESSION = await authenticateK4(/high\s*school/i);
  if (K4_SESSION) {
    const hsArticles = await enrichWithWorkflowSteps();
    allArticles.push(...hsArticles);
  } else {
    warn("Could not authenticate to High School K4.");
  }

  // 2. Fetch Elementary Articles
  log('--- FETCHING ELEMENTARY PUBS ---');
  K4_SESSION = await authenticateK4(/elementary/i);
  if (K4_SESSION) {
    const elemArticles = await enrichWithWorkflowSteps();
    for (const a of elemArticles) {
      if (!allArticles.some(ex => ex.id === a.id)) {
        allArticles.push(a);
      }
    }
  } else {
    warn("Could not authenticate to Elementary K4.");
  }

  log(`Total unique articles fetched: ${allArticles.length}`);

  const k4Map = {};
  for (const a of allArticles) {
    if (a.code && a.workflowStep !== 'Trash' && !a.name.toUpperCase().includes('TRASH')) {
      if (!k4Map[a.code]) k4Map[a.code] = [];
      k4Map[a.code].push(a);
    }
  }
  log(`  K4 unique item codes: ${Object.keys(k4Map).length}`);

  
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'k4_dump.json'), JSON.stringify(k4Map, null, 2));
  fs.writeFileSync(path.join(__dirname, 'k4Map.json'), JSON.stringify(k4Map, null, 2));
  console.log("DUMPED k4Map to k4_dump.json and k4Map.json!");
  
  // --- K4 HISTORY LEDGER ---
  const historyPath = path.join(__dirname, 'k4_history.json');
  let k4History = {};
  if (fs.existsSync(historyPath)) {
    try { k4History = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) { }
  }
  
  for (const a of allArticles) {
    if (!k4History[a.id]) {
      k4History[a.id] = { currentStep: a.workflowStep, history: {} };
    } else if (k4History[a.id].currentStep !== a.workflowStep) {
      // The article moved to a new step! The old step is now completed.
      const oldStep = k4History[a.id].currentStep;
      k4History[a.id].history[oldStep] = a.lastModified;
      k4History[a.id].currentStep = a.workflowStep;
    }
  }
  
  fs.writeFileSync(historyPath, JSON.stringify(k4History, null, 2));
  console.log("UPDATED k4_history.json ledger!");
  
  process.exit(0);
}
main().catch(console.error);
  