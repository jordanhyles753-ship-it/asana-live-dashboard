let dashboardData = [];
let myChart = null;
let currentProject = null;
let currentFilter = 'all';

async function fetchData() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();
    dashboardData = data.projects;
    renderSidebar();
    
    // If a project is currently open, re-render it to show live data
    if (currentProject) {
      const updatedP = dashboardData.find(p => p.id === currentProject.id);
      if (updatedP) {
        currentProject = updatedP;
        updateDashboardState(updatedP);
      }
    }
  } catch (e) {
    console.error('Error fetching dashboard data:', e);
  }
}

function renderSidebar() {
  const list = document.getElementById('project-list');
  const search = document.getElementById('search').value.toLowerCase();
  
  list.innerHTML = '';
  
  const filtered = dashboardData.filter(p => p.name.toLowerCase().includes(search));
  
  filtered.forEach(p => {
    let complete = 0, total = 0;
    p.sections.forEach(s => {
      complete += s.stats.complete;
      total += s.stats.total;
    });
    
    const pct = total === 0 ? 0 : Math.round((complete / total) * 100);
    const isActive = currentProject && currentProject.id === p.id;
    
    const div = document.createElement('div');
    div.className = `project-item ${isActive ? 'active' : ''}`;
    div.innerHTML = `
      <div class="project-item-name">${p.name}</div>
      <div class="project-item-code">${p.code || 'SYS'}</div>
    `;
    
    div.onclick = () => {
      document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
      
      // Use View Transitions API if supported
      if (!document.startViewTransition) {
        currentProject = p;
        updateDashboardState(p);
      } else {
        document.startViewTransition(() => {
          currentProject = p;
          updateDashboardState(p);
        });
      }
    };
    
    list.appendChild(div);
  });
}

function updateDashboardState(p) {
  document.getElementById('welcome-state').classList.add('hidden');
  document.getElementById('dashboard-state').classList.remove('hidden');
  
  document.getElementById('proj-title').textContent = p.name;
  document.getElementById('proj-k4-stage').textContent = 'K4 Stage: ' + (p.k4Stage || 'Unknown');
  
  let complete = 0, inProgress = 0, notStarted = 0, total = 0;
  
  p.sections.forEach(s => {
    complete += s.stats.complete;
    inProgress += s.stats.inProgress;
    notStarted += s.stats.notStarted;
    total += s.stats.total;
  });
  
  const pct = total === 0 ? 0 : Math.round((complete / total) * 100);
  document.getElementById('proj-pct').textContent = pct + '%';
  
  document.getElementById('stat-complete').textContent = complete;
  document.getElementById('stat-inprogress').textContent = inProgress;
  document.getElementById('stat-notstarted').textContent = notStarted;
  
  renderChart(complete, inProgress, notStarted);
  renderSections(p.sections);
}

function renderChart(c, i, n) {
  const ctx = document.getElementById('mainChart').getContext('2d');
  
  if (myChart) myChart.destroy();
  
  myChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Complete', 'In Progress', 'Not Started'],
      datasets: [{
        data: [c, i, n],
        backgroundColor: ['#34d399', '#fbbf24', '#475569'],
        borderWidth: 0,
        hoverOffset: 8,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '80%',
      layout: {
        padding: 10
      },
      animation: {
        animateScale: true,
        animateRotate: true
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          bodyFont: { weight: '600' },
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          boxPadding: 6,
          usePointStyle: true
        }
      }
    }
  });
}

function renderSections(sections) {
  const container = document.getElementById('sections-container');
  container.innerHTML = '';
  
  sections.forEach((s, index) => {
    // Only render section if it has tasks matching the filter
    const visibleTasks = s.tasks.filter(t => {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'complete' && t.status === 'Complete') return true;
      if (currentFilter === 'in-progress' && t.status === 'In Progress') return true;
      if (currentFilter === 'not-started' && t.status === 'Not Started') return true;
      return false;
    });

    if (visibleTasks.length === 0 && currentFilter !== 'all') return;

    const delayClass = `anim-delay-${Math.min(index, 5)}`;
    const html = `
      <div class="section-card collapsed ${delayClass}">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <h3>${s.name}</h3>
          <svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="tasks-list">
          ${(function() {
            function renderTask(t, depth = 0) {
              const isVisible = currentFilter === 'all' || 
                                (currentFilter === 'complete' && t.status === 'Complete') || 
                                (currentFilter === 'in-progress' && t.status === 'In Progress') ||
                                (currentFilter === 'not-started' && t.status === 'Not Started');
              
              let extraBadges = [];
              if (t.completed_at) {
                extraBadges.push(`<span class="t-due-badge badge-success">✅ Completed ${new Date(t.completed_at).toLocaleDateString()}</span>`);
              } else if (t.due_on) {
                const due = new Date(t.due_on);
                const isOverdue = due < new Date() && t.status !== 'Complete';
                const badgeClass = isOverdue ? 'badge-danger' : 'badge-primary';
                extraBadges.push(`<span class="t-due-badge ${badgeClass}">📅 Due ${due.toLocaleDateString()}</span>`);
              }

              if (t.assignee) {
                extraBadges.push(`<span class="t-assignee-badge">👤 ${t.assignee}</span>`);
              }
              if (t.timeOpenStr) {
                const hMatch = t.timeOpenStr.match(/(\d+)h/);
                const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
                let badgeColor = hours >= 48 ? 'badge-danger' : (hours >= 24 ? 'badge-warning' : 'badge-info');
                extraBadges.push(`<span class="t-days-badge ${badgeColor}">⏱️ Open for ${t.timeOpenStr}</span>`);
              }
              if (t.kanbanTimeStr) {
                const prefix = t.status === 'Complete' ? 'Took' : 'Logged';
                extraBadges.push(`<span class="t-days-badge badge-info">⏳ ${prefix} ${t.kanbanTimeStr}</span>`);
              }
              
              const hasSubtasks = t.subtasks && t.subtasks.length > 0;
              const subtasksHtml = hasSubtasks ? `<div class="subtasks-container">${t.subtasks.map(sub => renderTask(sub, depth + 1)).join('')}</div>` : '';
              const expandIcon = hasSubtasks ? `<svg class="task-expand-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>` : '';
              
              return `
              <div class="task-item ${isVisible ? '' : 'hidden'} st-${t.status.replace(' ', '')}">
                <div class="t-header">
                  <div class="t-status ${t.status.replace(' ', '')}" data-id="${t.id}" data-name="${t.name}"></div>
                  <div class="t-name">${t.name}</div>
                  ${expandIcon}
                </div>
                ${extraBadges.length > 0 ? `<div class="t-badges">${extraBadges.join(' ')}</div>` : ''}
                ${subtasksHtml}
              </div>
              `;
            }
            return s.tasks.map(t => renderTask(t)).join('');
          })()}
        </div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
  });
}

// Filter listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    currentFilter = e.target.getAttribute('data-filter');
    if (currentProject) {
      if (!document.startViewTransition) {
        renderSections(currentProject.sections);
      } else {
        document.startViewTransition(() => renderSections(currentProject.sections));
      }
    }
  });
});

document.getElementById('search').addEventListener('input', renderSidebar);

// Initial fetch and auto-refresh
fetchData();
setInterval(fetchData, 15 * 60 * 1000);

let currentUpdateTaskId = null;
const modal = document.getElementById('completion-modal');
const modalClose = document.getElementById('modal-close');
const modalSubmit = document.getElementById('modal-submit');
const inputDate = document.getElementById('completion-date');
const inputDuration = document.getElementById('completion-duration');

document.addEventListener('click', (e) => {
  const expandTarget = e.target.closest('.task-expand-icon');
  if (expandTarget) {
    const taskItem = expandTarget.closest('.task-item');
    if (taskItem) taskItem.classList.toggle('expanded');
    return;
  }
  
  if (e.target.classList.contains('t-status')) {
    currentUpdateTaskId = e.target.getAttribute('data-id');
    if (!currentUpdateTaskId || currentUpdateTaskId === "undefined") {
      alert("This task cannot be manually overridden yet (missing ID).");
      return;
    }
    
    const tzoffset = (new Date()).getTimezoneOffset() * 60000;
    const localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
    inputDate.value = localISOTime;
    inputDuration.value = '';
    
    modal.classList.remove('hidden');
  }
});

if(modalClose) modalClose.addEventListener('click', () => modal.classList.add('hidden'));

if(modalSubmit) modalSubmit.addEventListener('click', async () => {
  if (!currentUpdateTaskId) return;
  const dateStr = inputDate.value;
  const durStr = inputDuration.value;
  
  if (!dateStr) return alert("Date is required");
  
  modalSubmit.textContent = 'Saving...';
  modalSubmit.disabled = true;
  
  try {
    const res = await fetch('/api/update_task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentUpdateTaskId,
        completed_at: new Date(dateStr + 'T12:00:00').toISOString(),
        duration: durStr
      })
    });
    const result = await res.json();
    if (result.success) {
      modal.classList.add('hidden');
      await fetchData();
    } else {
      alert("Error saving: " + (result.error || "Unknown"));
    }
  } catch (e) {
    alert("Network error.");
  } finally {
    modalSubmit.textContent = 'Save Completion';
    modalSubmit.disabled = false;
  }
});


