console.log("Loading express...");
const express = require('express');
console.log("Loading fs...");
const fs = require('fs');
console.log("Loading path...");
const path = require('path');
console.log("Loading child_process...");
const { execSync } = require('child_process');

console.log("Setting up app...");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function extractAssigneeFromName(name) {
  if (!name) return null;
  const match = name.match(/Article(?:\s+(?:SE|TE))?\s+(.+)$/i);
  if (match && match[1]) {
    const extracted = match[1].trim();
    if (extracted.toUpperCase() !== 'CURR' && extracted.toUpperCase() !== 'TEST') {
      const clean = extracted.replace(/\bCurr\b/i, '').trim();
      return clean.length > 0 ? clean : null;
    }
  }
  return null;
}


console.log("Reading k4Map.json...");
const k4MapData = JSON.parse(fs.readFileSync(path.join(__dirname, 'k4Map.json'), 'utf8'));

// Load full K4 user directory fetched from K4 API
console.log("Loading K4 user directory...");
let k4UsersFromAPI = {};
try {
  k4UsersFromAPI = JSON.parse(fs.readFileSync(path.join(__dirname, 'k4_users.json'), 'utf8'));
  console.log(`Loaded ${Object.keys(k4UsersFromAPI).length} users from k4_users.json`);
} catch(e) {
  console.log('k4_users.json not found, falling back to manual map');
}

console.log("Building user map...");
function buildUserMap(k4Data) {
  // Start with API-fetched names as the authoritative source
  const map = Object.assign({}, k4UsersFromAPI);
  
  // Also extract names from article titles as a fallback for any missing IDs
  for (const k in k4Data) {
    k4Data[k].forEach(a => {
      const match = a.name.match(/Article(?:\s+(?:SE|TE))?\s+(.+)$/i);
      if (match && match[1] && a.assignedUserID && !map[a.assignedUserID]) {
        const n = match[1].replace(/\bCurr\b/i, '').replace(/[^a-zA-Z ]/g, '').trim();
        if (n.length > 2 && n.toUpperCase() !== 'TEST' && !['PILOT','FINAL','UPDATE','TRASH','EXTRA','TEMPLATE','BOARDS','UPDATED','REVOKED'].some(x => n.toUpperCase().includes(x))) {
          map[a.assignedUserID] = n;
        }
      }
    });
  }
  return map;
}

const k4UserMap = buildUserMap(k4MapData);

const WORKFLOW_ORDER = [
  'Draft',
  'Manager Draft Review',
  'Draft Review',
  'Layout Creation',
  'Pilot Layout Review',
  'Pilot Round',
  'Layout Review',
  'Proofing R1',
  'Editorial Round',
  'Editorial Round Final',
  'Pre-Apogee Proof R1',
  'Pre-Apogee Proof R2',
  'Apogee Proof',
  'Ready for Print Order',
  'Approved',
  'Ready to Route',
  'Route',
  'Print',
  'Printing Complete',
  'Copy Edit',
  'Final'
];

function normalizeStep(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/round/g, 'r').trim();
}

function matchSection(secStr, artName) {
  if (!secStr || !artName) return false;
  
  // Try direct include (ignoring spaces/case)
  const cSec = secStr.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const cArt = artName.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (cSec.includes(cArt) || cArt.includes(cSec)) return true;

  // Number extraction fallback (e.g. 'Lessons 1-10' vs 'L001-010' or '51-55' vs '51-60')
  const secNums = secStr.match(/\d+/g);
  const artNums = artName.match(/\d+/g);
  
  if (secNums && artNums && secNums.length >= 2 && artNums.length >= 2) {
    const s1 = parseInt(secNums[secNums.length-2]);
    const s2 = parseInt(secNums[secNums.length-1]);
    const a1 = parseInt(artNums[artNums.length-2]);
    const a2 = parseInt(artNums[artNums.length-1]);
    
    // Check for range overlap instead of exact match
    if (s1 <= a2 && s2 >= a1) return true;
  }
  
  // Front matter / Glossary
  if (secStr.toLowerCase().includes('front matter') && artName.toLowerCase().includes(' fm ')) return true;
  if (secStr.toLowerCase().includes('glossary') && artName.toLowerCase().includes('glossary')) return true;

  return false;
}

const KANBAN_TOKEN = 'L2S9F3YDZVH66UGM';
let cachedKanbanTasks = {};

async function fetchKanbanData(projects) {
  try {
    console.log('Fetching Kanban boards...');
    const r = await fetch('https://kanban.abeka.com/api/v1/boards?per_page=300', {
      headers: { Authorization: `Bearer ${KANBAN_TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) return;
    const boardsData = await r.json();
    const boards = boardsData.map(b => b.board);
    
    for (const proj of projects) {
      const codeMatch = proj.name.match(/^(\d{5,10})/);
      if (!codeMatch) continue;
      const code = codeMatch[1];
      const pname = proj.name.toLowerCase();
      
      const isRead = pname.includes('read');
      const isWriting = pname.includes('writing');
      const isLang = pname.includes('lang');
      const isSpell = pname.includes('spell');
      
      let matchedBoard = boards.find(b => {
         const bname = b.name.toLowerCase();
         if (!bname.includes(code)) return false;
         if (isRead && !bname.includes('read')) return false;
         if (isWriting && !bname.includes('writing')) return false;
         if (isLang && !bname.includes('lang')) return false;
         if (isSpell && !bname.includes('spell')) return false;
         return true;
      });
      if (!matchedBoard) matchedBoard = boards.find(b => b.name.includes(code));
      
      if (matchedBoard) {
        const tr = await fetch(`https://kanban.abeka.com/api/v1/boards/${matchedBoard.id}/tasks.json`, {
          headers: { Authorization: `Bearer ${KANBAN_TOKEN}`, Accept: 'application/json' },
        });
        if (!tr.ok) continue;
        const tasks = await tr.json();
        
        cachedKanbanTasks[proj.name] = {};
        for (const t of tasks) {
          if (t.name) cachedKanbanTasks[proj.name][t.name] = t.timers_total || 0;
        }
      }
    }
    console.log('Kanban tasks mapped for', Object.keys(cachedKanbanTasks).length, 'projects');
  } catch(e) {
    console.error('Error fetching Kanban data:', e.message);
  }
}

// In-memory data cache to prevent 80-second SMB read delays on every API request
let cachedK4Data = {};
let cachedAsanaData = [];
let k4HistoryData = {};
let manualOverrides = {};

// Function to load data into memory
async function loadDataIntoMemory(attempt = 1) {
  try {
    console.log(`Loading JSON data into memory (attempt ${attempt})...`);

    // k4_dump.json (may be empty {}; that's ok)
    try {
      const k4Raw = await fs.promises.readFile(path.join(__dirname, 'k4_dump.json'), 'utf8');
      cachedK4Data = JSON.parse(k4Raw);
    } catch(e) { cachedK4Data = {}; }

    // asana_dump.json — try __dirname first, then Desktop fallback
    const asanaPaths = [
      path.join(__dirname, 'asana_dump.json'),
      path.join(require('os').homedir(), 'Desktop', 'Asana_Live_Dashboard', 'asana_dump.json')
    ];
    let loaded = false;
    for (const p of asanaPaths) {
      try {
        const raw = await fs.promises.readFile(p, 'utf8');
        cachedAsanaData = JSON.parse(raw);
        console.log(`Asana data loaded from: ${p} (${cachedAsanaData.length} projects)`);
        loaded = true;
        break;
      } catch(e) { /* try next */ }
    }
    if (!loaded) throw new Error('asana_dump.json not found at any known path');

    // Also load k4Map into memory as the primary K4 data source
    try {
      const k4MapRaw = await fs.promises.readFile(path.join(__dirname, 'k4Map.json'), 'utf8');
      cachedK4Data = JSON.parse(k4MapRaw);
      console.log('K4 map loaded: ' + Object.keys(cachedK4Data).length + ' entries');
    } catch(e) { console.log('k4Map already loaded at startup'); }
    
    // Fetch Kanban timing data
    const allProjects = [...cachedAsanaData, { name: '432237 Read 6 Curr' }];
    await fetchKanbanData(allProjects);

    // Load manual overrides
    try {
      const overridesRaw = await fs.promises.readFile(path.join(__dirname, 'manual_overrides.json'), 'utf8');
      manualOverrides = JSON.parse(overridesRaw);
    } catch(e) {
      manualOverrides = {};
    }

    // Load k4_history
    try {
      const k4HistoryRaw = await fs.promises.readFile(path.join(__dirname, 'k4_history.json'), 'utf8');
      k4HistoryData = JSON.parse(k4HistoryRaw);
    } catch(e) {
      k4HistoryData = {};
    }

    console.log('JSON data loaded into memory successfully!');
  } catch (err) {
    console.error(`Error loading data (attempt ${attempt}):`, err.message);
    if (attempt < 4) {
      console.log(`Retrying in 3 seconds...`);
      setTimeout(() => loadDataIntoMemory(attempt + 1), 3000);
    }
  }
}

// Initial load
loadDataIntoMemory();

app.post('/api/update_task', async (req, res) => {
  try {
    const { id, completed_at, duration } = req.body;
    if (!id) return res.status(400).json({ error: 'Task ID required' });
    
    manualOverrides[id] = {
      status: 'Complete',
      completed_at: completed_at || new Date().toISOString(),
      duration: duration || null
    };
    
    // Save to disk
    await fs.promises.writeFile(path.join(__dirname, 'manual_overrides.json'), JSON.stringify(manualOverrides, null, 2));
    
    res.json({ success: true, override: manualOverrides[id] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', (req, res) => {
  try {
    // Use the instantly available in-memory data
    const k4Data = cachedK4Data;
    const asanaData = cachedAsanaData;
    
    if (!asanaData || asanaData.length === 0) {
      return res.json({ projects: [], stats: { totalProjects: 0 } });
    }
    
    let geometryTimeline = [];
    try {
      geometryTimeline = JSON.parse(fs.readFileSync(path.join(__dirname, 'geometry_se_timeline.json'), 'utf8'));
    } catch(e) {}
    const monthMap = { 'January':'01', 'February':'02', 'March':'03', 'April':'04', 'May':'05', 'June':'06', 'July':'07', 'August':'08', 'September':'09', 'October':'10', 'November':'11', 'December':'12' };
    
    function getGeometryDueDate(chapter, taskName) {
      if (!geometryTimeline.length || !chapter) return null;
      let searchRegex;
      if (taskName.match(/Draft|Edit/i)) {
         searchRegex = new RegExp('Ch ' + chapter + ' SE.*edit', 'i');
      } else if (taskName.match(/Pilot|Layout|Review|Proof/i)) {
         searchRegex = new RegExp('Ch ' + chapter + ' SE.*proof', 'i');
      } else if (taskName.match(/Editorial|Apogee/i)) {
         searchRegex = new RegExp('Ch ' + chapter + ' SE.*apogee', 'i');
      }
      
      if (searchRegex) {
         const match = geometryTimeline.find(t => searchRegex.test(t.task));
         if (match) {
            return match.year + '-' + monthMap[match.month] + '-' + String(match.day).padStart(2, '0');
         }
      }
      return null;
    }

    // We only send a subset of Asana data to avoid 54MB payload to browser
    let filteredAsanaData = asanaData.filter(p => {
       if (p.code === '432237' && (p.name.includes('Lang Curr') || p.name.includes('Writing Curr'))) return false;
       return true;
    });
    
    const projects = filteredAsanaData.map(p => {
      // Find matching K4 project to blend data
      let k4Stage = 'Unknown';
      if (k4Data[p.code] && k4Data[p.code].length > 0) {
        let maxIndex = -1;
        k4Data[p.code].forEach(a => {
           if (a.workflowStep) {
              const idx = WORKFLOW_ORDER.findIndex(w => normalizeStep(w) === normalizeStep(a.workflowStep));
              if (idx > maxIndex) maxIndex = idx;
           }
        });
        if (maxIndex !== -1) k4Stage = WORKFLOW_ORDER[maxIndex];
      }
      
      const k4Articles = k4Data[p.code] || [];

      return {
        id: p.id,
        name: p.name,
        code: p.code,
        k4Stage: k4Stage,
        sections: p.sections.map(s => {
          let complete = 0;
          let inProgress = 0;
          let notStarted = 0;
          
          let k4Assignee = null;
          let k4CurrentStep = null;
          let k4CurrentIndex = -1;
          
          const secName = s.section || s.name;
          // Match section to K4 article (e.g. "Abeka CH1 Article" roughly matches)
          const matchedArticle = k4Articles.find(a => matchSection(secName, a.name));
          
          if (matchedArticle) {
            k4CurrentStep = matchedArticle.workflowStep;
            k4Assignee = extractAssigneeFromName(matchedArticle.name);
            k4CurrentIndex = WORKFLOW_ORDER.findIndex(w => normalizeStep(w) === normalizeStep(k4CurrentStep));
          }
          
          function processTask(t, forcedStatus = null) {
            let assignee = null;
            if (t.assignee && t.assignee.name) {
              assignee = t.assignee.name;
            } else {
              const assignedToField = t.custom_fields && t.custom_fields.find(f => f.name === 'Assigned To');
              if (assignedToField && assignedToField.text_value) assignee = assignedToField.text_value;
            }

            const normTask = normalizeStep(t.name);
            let taskIndex = -1;
            const stepMatchIndex = WORKFLOW_ORDER.findIndex(w => normalizeStep(w) === normTask || normTask.includes(normalizeStep(w)));
            if (stepMatchIndex !== -1) {
               taskIndex = stepMatchIndex;
            }
            
            let currentForcedStatus = forcedStatus;
            
            if (k4CurrentIndex !== -1 && taskIndex !== -1) {
               if (taskIndex < k4CurrentIndex) {
                  currentForcedStatus = 'Complete';
               } else if (taskIndex > k4CurrentIndex) {
                  currentForcedStatus = 'Not Started';
               }
            }

            // Prioritize K4 assignee if this task matches K4's current workflow step
            if (k4CurrentStep && k4Assignee && normTask === normalizeStep(k4CurrentStep)) {
              assignee = k4Assignee;
            }

            if (assignee && assignee.startsWith('K4 User ')) {
              const id = assignee.replace('K4 User ', '');
              if (k4UserMap[id]) assignee = k4UserMap[id];
              else assignee = 'User ' + id;
            }
            if (k4CurrentStep && !k4Assignee && normTask === normalizeStep(k4CurrentStep)) {
              const k4MapArticle = Object.values(k4MapData).flat().find(mapA => mapA.name === matchedArticle.name);
              if (k4MapArticle && k4MapArticle.assignedUserID) {
                const mappedName = k4UserMap[k4MapArticle.assignedUserID];
                if (mappedName) assignee = mappedName;
              }
            }

            let parsedCompletedAt = null;
            if (manualOverrides[t.id] && manualOverrides[t.id].completed_at) {
              parsedCompletedAt = manualOverrides[t.id].completed_at;
            } else if (matchedArticle && taskIndex !== -1 && k4CurrentIndex !== -1 && taskIndex < k4CurrentIndex) {
              // K4 task that is complete
              const articleHistory = k4HistoryData[matchedArticle.id];
              let historyDate = null;
              if (articleHistory && articleHistory.history) {
                 const stepName = WORKFLOW_ORDER[taskIndex];
                 historyDate = articleHistory.history[stepName];
                 if (!historyDate) {
                    const normT = normalizeStep(stepName);
                    const key = Object.keys(articleHistory.history).find(k => normalizeStep(k) === normT);
                    if (key) historyDate = articleHistory.history[key];
                 }
              }
              // If we don't have exact history (e.g. from before the ledger started),
              // fall back to the article's lastModified date.
              parsedCompletedAt = historyDate || matchedArticle.lastModified || null;
            } else {
              // Forced to only use K4 for Date Completed, ignoring Asana's completed_at
              parsedCompletedAt = null;
            }

            let status = 'Not Started';

            if (parsedCompletedAt || t.completed) {
               status = 'Complete';
               complete++;
            } else if (currentForcedStatus) {
               status = currentForcedStatus;
               if (status === 'Complete') complete++;
               else if (status === 'In Progress') { inProgress++; }
               else notStarted++;
            } else if (k4CurrentIndex !== -1 && taskIndex === k4CurrentIndex) {
               status = 'In Progress';
               inProgress++;
            } else {
               if (assignee) {
                 inProgress++;
                 status = 'In Progress';
               } else {
                 notStarted++;
               }
            }
            
            let finalDue = t.due_on || null;
            if (p.name.includes('290319 Geometry SE')) {
              const chMatch = (s.section || s.name).match(/Chapter (\\d+)/i);
              if (chMatch) {
                 const injectedDate = getGeometryDueDate(chMatch[1], t.name);
                 if (injectedDate) finalDue = injectedDate;
              }
            }
            
            let kanbanTimeStr = null;
            // Removed Asana timer logic to rely purely on K4 time took
            
            if (manualOverrides[t.id] && manualOverrides[t.id].duration) {
              kanbanTimeStr = manualOverrides[t.id].duration;
            }

            
            return { 
              id: t.id,
              name: t.name, 
              status, 
              type: 'task',
              due_on: finalDue,
              completed_at: parsedCompletedAt,
              assignee: assignee,
              kanbanTimeStr: kanbanTimeStr,
              subtasks: (t.subtasks && Array.isArray(t.subtasks)) ? t.subtasks.map(sub => processTask(sub, currentForcedStatus)) : []
            };
          }
          const tasks = s.tasks.map(t => processTask(t));
          
          return {
            name: s.section || s.name,
            tasks: tasks,
            stats: { complete, inProgress, notStarted, total: complete + inProgress + notStarted }
          };
        })
      };
    });
    
    const READ6_WORKFLOW_ORDER = [
      'Draft', 'Manager Draft Review', 'Draft Review', 'Layout Creation',
      'Layout Review', 'Proofing R1', 'Editorial Round', 'Editorial Round Final',
      'Pre-Apogee Proof R1', 'Pre-Apogee Proof R2', 'Apogee Proof',
      'Ready for Print Order', 'Approved', 'Ready to Route', 'Route', 'Print',
      'Printing Complete', 'Copy Edit', 'Final'
    ];

    // Helper to synthesize projects from K4
    function synthesizeProject(code, projectName, idStr, articleNameFilter, regexExtractor, workflowOrder, asanaProjectId) {
      const articles = (k4Data[code] || []).filter(a => a.name && articleNameFilter(a.name));
      if (articles.length === 0) return null;
      
      const asanaProject = asanaData.find(p => p.id === asanaProjectId);
      
      const sectionsMap = {};
      articles.forEach(a => {
        const m = a.name.match(regexExtractor);
        const secName = m ? m[1] : 'Other';
        if (!sectionsMap[secName]) sectionsMap[secName] = [];
        sectionsMap[secName].push(a);
      });
      
      const syntheticSections = Object.keys(sectionsMap).sort().map(secName => {
        const secArticles = sectionsMap[secName];
        let maxIndex = 0;
        let assignedUserFromName = null;
        let maxArticleModified = null;
        let maxArticleId = null;
        
        // Find matching Asana section for time data
        let matchedAsanaSection = null;
        if (asanaProject) {
           matchedAsanaSection = asanaProject.sections.find(s => matchSection(s.section, secName));
        }
        
        secArticles.forEach(a => {
          if (a.workflowStep) {
            let idx = workflowOrder.indexOf(a.workflowStep);
            if (idx === -1) idx = 0;
            if (idx > maxIndex) {
              maxIndex = idx;
              maxArticleModified = a.lastModified;
              maxArticleId = a.id;
            } else if (idx === maxIndex) {
              if (!maxArticleModified || new Date(a.lastModified) > new Date(maxArticleModified)) {
                 maxArticleModified = a.lastModified;
                 maxArticleId = a.id;
              }
            }
          }
          
          const extracted = extractAssigneeFromName(a.name);
          if (extracted) {
            assignedUserFromName = extracted;
          } else if (a.assignedUserID) {
             const mappedName = k4UserMap[a.assignedUserID];
             if (mappedName) assignedUserFromName = mappedName;
             else assignedUserFromName = 'User ' + a.assignedUserID;
          } else {
             const k4MapArticle = Object.values(k4MapData).flat().find(mapA => mapA.name === a.name);
             if (k4MapArticle && k4MapArticle.assignedUserID) {
               const mappedName = k4UserMap[k4MapArticle.assignedUserID];
               if (mappedName) assignedUserFromName = mappedName;
               else assignedUserFromName = 'User ' + k4MapArticle.assignedUserID;
             }
          }
        });
        
        let timeOpenStr = null;
        if (maxArticleModified) {
          const diffMs = Date.now() - new Date(maxArticleModified).getTime();
          const totalMins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
          const h = Math.floor(totalMins / 60);
          const m = totalMins % 60;
          timeOpenStr = `${h}h ${m}m`;
        }
        
        let complete = 0, inProgress = 0, notStarted = 0;
        let previousTaskCompletedAt = null;
        
        const tasks = workflowOrder.map((stepName, index) => {
          let status = 'Not Started';
          let assignee = null;
          let taskTimeOpen = null;
          let parsedCompletedAt = null;
          
          // Asana Task matching removed - forcing K4 only for Date Completed

          
          if (index < maxIndex) {
            status = 'Complete';
            complete++;
            
            if (maxArticleId) {
               const articleHistory = k4HistoryData[maxArticleId];
               let historyDate = null;
               if (articleHistory && articleHistory.history) {
                 historyDate = articleHistory.history[stepName];
                 if (!historyDate) {
                    const normT = normalizeStep(stepName);
                    const key = Object.keys(articleHistory.history).find(k => normalizeStep(k) === normT);
                    if (key) historyDate = articleHistory.history[key];
                 }
               }
               parsedCompletedAt = historyDate || maxArticleModified || null;
            }
          } else if (index === maxIndex) {
            status = 'In Progress';
            inProgress++;
            assignee = assignedUserFromName;
            taskTimeOpen = timeOpenStr;
          } else {
            status = 'Not Started';
            notStarted++;
          }
          
          let taskKanbanTime = null;
          let kanbanFound = false;
          if (cachedKanbanTasks[projectName]) {
             let totalSecs = 0;
             const stepMap = {
               'Draft': 'content:',
               'Edit': 'design:',
               'Layout': 'layout',
               'Proofing R1': 'full proof:',
               'Proofing R2': 'proofing corrections:'
             };
             const prefix = stepMap[stepName];
             if (prefix) {
                for (const [kTaskName, kTime] of Object.entries(cachedKanbanTasks[projectName])) {
                   // Ensure it's for this specific section! e.g. "Full Proof: L 81-90" includes "81-90"
                   if (kTaskName.toLowerCase().startsWith(prefix) && kTaskName.replace(/[^a-z0-9]/gi, '').includes(secName.replace(/[^a-z0-9]/gi, ''))) {
                      totalSecs += kTime;
                      kanbanFound = true;
                   }
                }
             }
             
             if (totalSecs > 0) {
                const totalMins = Math.floor(totalSecs / 60);
                const h = Math.floor(totalMins / 60);
                const m = totalMins % 60;
                taskKanbanTime = `${h}h ${m}m`;
             }
          }
          
          let asanaCompletedAt = null;
          if (matchedAsanaSection && matchedAsanaSection.tasks) {
             const normStepName = normalizeStep(stepName);
             const aTask = matchedAsanaSection.tasks.find(t => normalizeStep(t.name) === normStepName || t.name.toLowerCase().includes(stepName.toLowerCase()));
             if (aTask && aTask.completed_at) {
                asanaCompletedAt = new Date(aTask.completed_at).getTime();
             }
          }

          // Fallback to Asana completed_at duration
          if (!taskKanbanTime && status === 'Complete' && asanaCompletedAt) {
             if (previousTaskCompletedAt) {
                const diffSecs = Math.floor((asanaCompletedAt - previousTaskCompletedAt) / 1000);
                if (diffSecs >= 0) {
                  const totalMins = Math.floor(diffSecs / 60);
                  const h = Math.floor(totalMins / 60);
                  const m = totalMins % 60;
                  taskKanbanTime = `${h}h ${m}m`;
                }
             }
          }
          
          if (asanaCompletedAt) {
             previousTaskCompletedAt = asanaCompletedAt;
          }
          
          return {
            name: stepName,
            status,
            type: 'task',
            due_on: null,
            completed_at: parsedCompletedAt,
            assignee,
            timeOpenStr: taskTimeOpen,
            kanbanTimeStr: taskKanbanTime
          };
        });

        return {
          name: secName,
          tasks,
          stats: { complete, inProgress, notStarted, total: tasks.length }
        };
      });
      
      return {
        id: idStr,
        name: projectName,
        code: code,
        k4Stage: 'Live from K4',
        sections: syntheticSections
      };
    }

    const synRead = synthesizeProject(
       '432237', 
       '432237 Read 6 Curr', 
       'synthetic_432237_read_6',
       n => n.includes('Read') && !n.toUpperCase().includes('TRASH'),
       /Read(?:ing)? 6 ([\w-]+)/,
       READ6_WORKFLOW_ORDER,
       null // no matching asana project for Read 6 Curr
    );
    if (synRead) projects.push(synRead);

    const synWriting = synthesizeProject(
       '432237',
       '432237 Language Arts 6 Writing Curr',
       'synthetic_432237_writing_6',
       n => n.includes('Writing') && !n.toUpperCase().includes('TRASH'),
       /Writing 6\s+L?\s*([a-zA-Z0-9\-\–]+)/,
       WORKFLOW_ORDER,
       '1211454563481808' // 432237 Language Arts 6 Writing Curr
    );
    if (synWriting) projects.push(synWriting);

    const synLang = synthesizeProject(
       '432237',
       '432237 Language Arts 6 Lang Curr',
       'synthetic_432237_lang_6',
       n => (n.match(/Lang 6/i) || n.match(/LA 6 SVP/i)) && !n.toUpperCase().includes('TRASH'),
       /(?:Lang 6|LA 6 SVP)\s+L?\s*([a-zA-Z0-9\-\–]+)/i,
       WORKFLOW_ORDER,
       '1211428196243421' // 432237 Language Arts 6 Lang Curr
    );
    if (synLang) projects.push(synLang);
    res.json({ projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

console.log("Starting server...");
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Live Dashboard running on http://localhost:${PORT}`);
});

// Run sync immediately on startup (in background) and then every 15 mins
runSync();
setInterval(() => runSync(), 15 * 60 * 1000);

async function runSync() {
  console.log('Running 15-min K4 & Asana Sync...');
  try {
    console.log('Syncing K4 Data...');
    const os = require('os');
    let k4Cmd = `node "${path.join(__dirname, 'dump_sync_fast.js')}" > /dev/null 2>&1`;
    let asanaCmd = `node "${path.join(__dirname, 'export_asana.js')}" > /dev/null 2>&1`;

    const util = require('util');
    const exec = util.promisify(require('child_process').exec);
    await exec(k4Cmd);
    console.log('Syncing Asana Data...');
    await exec(asanaCmd);
    console.log('Sync Complete.');
    
    // Refresh the in-memory cache now that the files have been updated
    loadDataIntoMemory();
  } catch (e) {
    console.error('Sync failed:', e.message);
  }
}
