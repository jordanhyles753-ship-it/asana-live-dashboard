const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
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


const k4MapData = JSON.parse(fs.readFileSync('/Users/jordan.jones/Desktop/k4Map.json', 'utf8'));

function buildUserMap(k4Data) {
  const map = {};
  for (const k in k4Data) {
    k4Data[k].forEach(a => {
      const match = a.name.match(/Article(?:\s+(?:SE|TE))?\s+(.+)$/i);
      if (match && match[1]) {
        const n = match[1].replace(/\bCurr\b/i, '').replace(/[^a-zA-Z ]/g, '').trim();
        if (n.length > 2 && n.toUpperCase() !== 'TEST' && !['PILOT','FINAL','UPDATE','TRASH','EXTRA','TEMPLATE','BOARDS','UPDATED','REVOKED'].some(x => n.toUpperCase().includes(x)) && a.assignedUserID) {
          map[a.assignedUserID] = n;
        }
      }
    });
  }
  map['20039318'] = 'Wendy Groff';
  map['22041270'] = 'Karis Wesley';
  map['22043124'] = 'Caleb Burdick';
  map['20039266'] = 'Jessica Garcia';
  map['19775718'] = 'Kaylee Millard';
  map['565'] = 'Jennifer Pade';
  return map;
}
const k4UserMap = buildUserMap(k4MapData);

app.get('/api/data', (req, res) => {

  try {
    const k4Data = JSON.parse(fs.readFileSync('/Users/jordan.jones/Desktop/k4_dump.json', 'utf8'));
    const asanaData = JSON.parse(fs.readFileSync('/Users/jordan.jones/Desktop/asana_dump.json', 'utf8'));
    
    // We only send a subset of Asana data to avoid 54MB payload to browser
    const projects = asanaData.map(p => {
      // Find matching K4 project to blend data
      const k4Project = Object.values(k4Data).find(k => k.code === p.code);
      const k4Stage = k4Project ? k4Project.maxWorkflowStep : 'Unknown';
      
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
          
          // Match section to K4 article (e.g. "Abeka CH1 Article" roughly matches)
          const matchedArticle = k4Articles.find(a => {
            if (!s.name || !a.name) return false;
            const cleanS = s.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            const cleanA = a.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            return cleanS.includes(cleanA) || cleanA.includes(cleanS);
          });
          
          if (matchedArticle) {
            k4CurrentStep = matchedArticle.workflowStep;
            k4Assignee = extractAssigneeFromName(matchedArticle.name);
          }
          
          const tasks = s.tasks.map(t => {
            let assignee = null;
            if (t.assignee && t.assignee.name) {
              assignee = t.assignee.name;
            } else {
              const assignedToField = t.custom_fields && t.custom_fields.find(f => f.name === 'Assigned To');
              if (assignedToField && assignedToField.text_value) assignee = assignedToField.text_value;
            }

            // Prioritize K4 assignee if this task matches K4's current workflow step
            if (k4CurrentStep && k4Assignee && t.name.toLowerCase() === k4CurrentStep.toLowerCase()) {
              assignee = k4Assignee;
            }


            if (assignee && assignee.startsWith('K4 User ')) {
              const id = assignee.replace('K4 User ', '');
              if (k4UserMap[id]) assignee = k4UserMap[id];
              else assignee = 'User ' + id;
            }
            if (k4CurrentStep && !k4Assignee && t.name.toLowerCase() === k4CurrentStep.toLowerCase()) {
              const k4MapArticle = Object.values(k4MapData).flat().find(mapA => mapA.name === matchedArticle.name);
              if (k4MapArticle && k4MapArticle.assignedUserID) {
                const mappedName = k4UserMap[k4MapArticle.assignedUserID];
                if (mappedName) assignee = mappedName;
              }
            }

            let status = 'Not Started';

            if (t.completed) {
              complete++;
              status = 'Complete';
            } else if (assignee) {
              inProgress++;
              status = 'In Progress';
            } else {
              notStarted++;
            }
            return { 
              name: t.name, 
              status, 
              type: 'task',
              due_on: t.due_on || null,
              completed_at: t.completed_at || null,
              assignee: assignee
            };
          });
          
          return {
            name: s.section || s.name,
            tasks: tasks,
            stats: { complete, inProgress, notStarted, total: tasks.length }
          };
        })
      };
    });
    
    // Inject synthetic 432237 Read 6 Curr
    const read6Articles = (k4Data['432237'] || []).filter(a => a.name && a.name.includes('Read'));
    if (read6Articles.length > 0) {
      const sectionsMap = {};
      read6Articles.forEach(a => {
        const m = a.name.match(/Read(?:ing)? 6 ([\w-]+)/);
        const secName = m ? m[1] : 'Other';
        if (!sectionsMap[secName]) sectionsMap[secName] = [];
        sectionsMap[secName].push(a);
      });
      
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

      const syntheticSections = Object.keys(sectionsMap).sort().map(secName => {
        // Find the article that has the furthest workflow step
        // Or if there are multiple articles (like Article and LYT), we use the one with the highest index
        const articles = sectionsMap[secName];
        let maxIndex = 0;
        let assignedUserFromName = null;
        
        articles.forEach(a => {
          if (a.workflowStep) {
            let idx = WORKFLOW_ORDER.indexOf(a.workflowStep);
            if (idx === -1) idx = 0; // fallback if unknown
            if (idx >= maxIndex) {
              maxIndex = idx;
              currentStepName = a.workflowStep;
            }
          }
          const extracted = extractAssigneeFromName(a.name);
          if (extracted) {
            assignedUserFromName = extracted;
          } else {
             const k4MapArticle = Object.values(k4MapData).flat().find(mapA => mapA.name === a.name);
             if (k4MapArticle && k4MapArticle.assignedUserID) {
               const mappedName = k4UserMap[k4MapArticle.assignedUserID];
               if (mappedName) assignedUserFromName = mappedName;
               else assignedUserFromName = 'User ' + k4MapArticle.assignedUserID;
             }
          }
        });
        
        let complete = 0, inProgress = 0, notStarted = 0;
        const tasks = WORKFLOW_ORDER.map((stepName, index) => {
          let status = 'Not Started';
          let assignee = null;
          
          if (index < maxIndex) {
            status = 'Complete';
            complete++;
          } else if (index === maxIndex) {
            status = 'In Progress';
            inProgress++;
            assignee = assignedUserFromName;
          } else {
            status = 'Not Started';
            notStarted++;
          }
          
          return {
            name: stepName,
            status,
            type: 'task',
            due_on: null,
            completed_at: null,
            assignee
          };
        });

        return {
          name: secName,
          tasks,
          stats: { complete, inProgress, notStarted, total: tasks.length }
        };
      });
      
      projects.push({
        id: 'synthetic_432237_read_6',
        name: '432237 Read 6 Curr',
        code: '432237',
        k4Stage: 'Live from K4',
        sections: syntheticSections
      });
    }

    res.json({ projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Live Dashboard running on http://localhost:${PORT}`);
});

// Run sync immediately on startup (in background) and then every 15 mins
setInterval(() => runSync(), 15 * 60 * 1000);

function runSync() {
  console.log('Running 15-min K4 & Asana Sync...');
  try {
    console.log('Syncing K4 Data...');
    execSync('node /Users/jordan.jones/Desktop/dump_sync_fast.js > /dev/null 2>&1');
    console.log('Syncing Asana Data...');
    execSync('node /Users/jordan.jones/Desktop/export_asana.js > /dev/null 2>&1');
    console.log('Sync Complete! Data is perfectly up to date.');
  } catch (e) {
    console.error('Sync failed:', e.message);
  }
}
