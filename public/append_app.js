
// Navigation logic
const navProjects = document.getElementById('nav-projects');
if (navProjects) {
  navProjects.addEventListener('click', (e) => {
    document.getElementById('nav-timeline').classList.remove('active');
    e.target.classList.add('active');
    
    // Show projects sidebar content
    document.querySelector('.search-wrapper').style.display = 'flex';
    document.getElementById('project-list').style.display = 'block';
    
    // Show correct main state
    document.getElementById('timeline-state').classList.add('hidden');
    if (currentProject) {
      document.getElementById('dashboard-state').classList.remove('hidden');
    } else {
      document.getElementById('welcome-state').classList.remove('hidden');
    }
  });
}

const navTimeline = document.getElementById('nav-timeline');
if (navTimeline) {
  navTimeline.addEventListener('click', (e) => {
    document.getElementById('nav-projects').classList.remove('active');
    e.target.classList.add('active');
  
  // Hide projects sidebar content
  document.querySelector('.search-wrapper').style.display = 'none';
  document.getElementById('project-list').style.display = 'none';
  
  // Show timeline state
  document.getElementById('welcome-state').classList.add('hidden');
  document.getElementById('dashboard-state').classList.add('hidden');
  document.getElementById('timeline-state').classList.remove('hidden');
  
  fetchTimeline();
});
}

async function fetchTimeline() {
  try {
    const res = await fetch('/api/timeline');
    const timelineData = await res.json();
    renderTimeline(timelineData);
  } catch (e) {
    console.error('Error fetching timeline data:', e);
  }
}

function renderTimeline(data) {
  const container = document.getElementById('timeline-container');
  container.innerHTML = '';
  
  // Group by month-year
  const grouped = {};
  data.forEach(item => {
    const key = `${item.month} ${item.year}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });
  
  let html = '';
  for (const [monthYear, items] of Object.entries(grouped)) {
    html += `<div class="timeline-month">
      <div class="timeline-month-header">${monthYear}</div>`;
      
    items.forEach((item, index) => {
      let taskStr = item.task.replace(/\r?\n/g, '<br>');
      // Bold lines with 'SE'
      taskStr = taskStr.split('<br>').map(line => {
        if (line.includes('SE')) return `<strong>${line}</strong>`;
        return line;
      }).join('<br>');
      
      const delayClass = `anim-delay-${Math.min(index, 5)}`;
      
      html += `
        <div class="timeline-item ${delayClass}">
          <div class="timeline-dot"></div>
          <div class="timeline-date">${item.month.substring(0,3)} ${item.day}</div>
          <div class="timeline-card glass-card">
            <div class="timeline-task">${taskStr}</div>
          </div>
        </div>
      `;
    });
    
    html += `</div>`;
  }
  
  container.innerHTML = html;
}
