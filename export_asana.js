const https = require('https');
const fs = require('fs');

require('dotenv').config();
const TOKEN = process.env.ASANA_TOKEN;
const WORKSPACE = '1123446613688331';

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function asanaGet(endpoint) {
  return new Promise((resolve, reject) => {
    const doReq = () => {
      const options = {
        hostname: 'app.asana.com',
        path: '/api/1.0' + endpoint,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}` },
        agent: new https.Agent({ keepAlive: true })
      };
      const req = https.request(options, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', async () => {
          if (res.statusCode === 429) {
            const retryAfter = res.headers['retry-after'];
            const waitTime = retryAfter ? (parseInt(retryAfter) * 1000 + 1000) : 10000;
            console.log(`Rate limited! Waiting ${waitTime}ms...`);
            await delay(waitTime);
            return doReq();
          }
          if (res.statusCode >= 500) {
            await delay(5000);
            return doReq();
          }
          if (res.statusCode >= 400) return reject(new Error(`API Error ${res.statusCode}`));
          resolve(JSON.parse(body));
        });
      });
      req.on('error', reject);
      req.end();
    };
    doReq();
  });
}

async function asanaGetAll(baseEndpoint) {
  let allData = [];
  let nextOffset = null;
  do {
    const separator = baseEndpoint.includes('?') ? '&' : '?';
    const endpoint = nextOffset ? `${baseEndpoint}${separator}offset=${nextOffset}` : baseEndpoint;
    const res = await asanaGet(endpoint);
    allData = allData.concat(res.data || []);
    nextOffset = res.next_page ? res.next_page.offset : null;
  } while (nextOffset);
  return allData;
}

const OPT_FIELDS = 'name,memberships.section.name,subtasks.name,subtasks.assignee.name,subtasks.completed,subtasks.created_at,subtasks.due_on,subtasks.completed_at,assignee.name,created_at,due_on,completed_at,completed,custom_fields';

async function exportAsana() {
  console.log('Fetching all projects...');
  const projects = await asanaGetAll(`/projects?workspace=${WORKSPACE}&limit=100&opt_fields=name`);
  const allExportData = [];

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    
    const match = p.name.match(/^(\d{6})/);
    if (!match) continue;
    
    console.log(`Processing [${i+1}/${projects.length}]: ${p.name}`);
    
    const projData = { id: p.gid, name: p.name, code: match[1], sections: [] };
    
    // FETCH EVERYTHING IN 1 QUERY (paginated)
    const flatTasks = await asanaGetAll(`/projects/${p.gid}/tasks?opt_fields=${OPT_FIELDS}&limit=100`);
    
    // Group by section
    const sectionMap = {};
    for (const t of flatTasks) {
      const secName = t.memberships && t.memberships.length > 0 && t.memberships[0].section ? t.memberships[0].section.name : 'Untitled section';
      if (!sectionMap[secName]) {
        sectionMap[secName] = { section: secName, tasks: [] };
        projData.sections.push(sectionMap[secName]);
      }
      
      const taskData = {
        id: t.gid,
        name: t.name,
        assignee: t.assignee,
        created_at: t.created_at,
        due_on: t.due_on,
        completed_at: t.completed_at,
        completed: t.completed,
        custom_fields: t.custom_fields,
        subtasks: t.subtasks || []
      };
      
      sectionMap[secName].tasks.push(taskData);
    }
    
    allExportData.push(projData);
    console.log(`Saved ${projData.sections.length} sections for ${p.name}`);
  }
  
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'asana_dump.json'), JSON.stringify(allExportData, null, 2));
  console.log('=== Export Complete ===');
  // console.log('Executing Dashboard Generator...');
  // require('child_process').execSync('node DashboardGenerator/generate_dashboard.js', { stdio: 'inherit' });
}
exportAsana().catch(console.error);
