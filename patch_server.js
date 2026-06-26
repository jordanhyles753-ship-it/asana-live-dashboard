const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

// 1. Add buildUserMap function
const buildUserMapFunc = `
const k4MapData = JSON.parse(fs.readFileSync('/Users/jordan.jones/Desktop/k4Map.json', 'utf8'));

function buildUserMap(k4Data) {
  const map = {};
  for (const k in k4Data) {
    k4Data[k].forEach(a => {
      const match = a.name.match(/Article(?:\\s+(?:SE|TE))?\\s+(.+)$/i);
      if (match && match[1]) {
        const n = match[1].replace(/\\bCurr\\b/i, '').replace(/[^a-zA-Z ]/g, '').trim();
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
`;
code = code.replace("app.get('/api/data', (req, res) => {", buildUserMapFunc);

// 2. Add Asana task K4 User mapping
const asanaTaskLogic = `
            let status = 'Not Started';
`;
const asanaTaskReplacement = `
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
`;
code = code.replace("            let status = 'Not Started';", asanaTaskReplacement);

// 3. Add synthetic mapping
const syntheticLogic = `          const extracted = extractAssigneeFromName(a.name);
          if (extracted) assignedUserFromName = extracted;
        });`;
const syntheticReplacement = `          const extracted = extractAssigneeFromName(a.name);
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
        });`;
code = code.replace(syntheticLogic, syntheticReplacement);

fs.writeFileSync('server.js', code);
console.log('Patched server.js');
