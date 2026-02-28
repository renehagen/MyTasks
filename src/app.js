(function () {
  'use strict';

  const API_BASE = '/api';
  let apiKey = localStorage.getItem('mytasks_api_key') || '';

  // --- DOM refs ---
  const authGate = document.getElementById('auth-gate');
  const apiKeyInput = document.getElementById('api-key-input');
  const authSubmit = document.getElementById('auth-submit');
  const authError = document.getElementById('auth-error');
  const mainApp = document.getElementById('main-app');
  const logoutBtn = document.getElementById('logout-btn');

  const filterSearch = document.getElementById('filter-search');
  const filterStatus = document.getElementById('filter-status');
  const filterPriority = document.getElementById('filter-priority');

  const taskListEl = document.getElementById('task-list');
  const emptyState = document.getElementById('empty-state');
  const addTaskBtn = document.getElementById('add-task-btn');

  const taskModal = document.getElementById('task-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalClose = document.getElementById('modal-close');
  const taskForm = document.getElementById('task-form');
  const taskIdField = document.getElementById('task-id');
  const taskTitleField = document.getElementById('task-title');
  const taskStatusField = document.getElementById('task-status');
  const taskPriorityField = document.getElementById('task-priority');
  const taskDueField = document.getElementById('task-due');
  const taskNotesField = document.getElementById('task-notes');
  const deleteTaskBtn = document.getElementById('delete-task-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const toastEl = document.getElementById('toast');

  // --- API Client ---
  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        ...options.headers
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // --- Toast ---
  let toastTimer;
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => { toastEl.hidden = true; }, 200);
    }, 2500);
  }

  // --- Auth ---
  async function tryAuth(key) {
    apiKey = key;
    try {
      await api('/tasks');
      localStorage.setItem('mytasks_api_key', key);
      authGate.hidden = true;
      mainApp.hidden = false;
      loadTasks();
    } catch {
      apiKey = '';
      throw new Error('Invalid API key');
    }
  }

  authSubmit.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) return;
    authError.hidden = true;
    authSubmit.disabled = true;
    authSubmit.textContent = 'Connecting...';
    try {
      await tryAuth(key);
    } catch (e) {
      authError.textContent = e.message;
      authError.hidden = false;
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = 'Connect';
    }
  });

  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authSubmit.click();
  });

  logoutBtn.addEventListener('click', () => {
    apiKey = '';
    localStorage.removeItem('mytasks_api_key');
    mainApp.hidden = true;
    authGate.hidden = false;
    apiKeyInput.value = '';
    authError.hidden = true;
  });

  // --- Task Rendering ---
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function isOverdue(dateStr) {
    if (!dateStr) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(dateStr + 'T00:00:00') < today;
  }

  function renderTask(task) {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.dataset.id = task.id;

    const isDone = task.status === 'done' || task.status === 'cancelled';
    const titleClass = isDone ? ' done' : '';
    const dueHtml = task.dueDate
      ? `<span class="task-row-due${isOverdue(task.dueDate) && !isDone ? ' overdue' : ''}">${formatDate(task.dueDate)}</span>`
      : '';

    row.innerHTML = `
      <span class="task-row-priority ${task.priority}"></span>
      <span class="task-row-title${titleClass}">${escapeHtml(task.title)}</span>
      ${dueHtml}
      <span class="task-row-status ${task.status}">${task.status}</span>
      <button class="task-row-check${isDone ? ' checked' : ''}" title="${isDone ? 'Reopen' : 'Mark done'}">&#x2713;</button>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.task-row-check')) return;
      openEditModal(task);
    });

    row.querySelector('.task-row-check').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const newStatus = isDone ? 'todo' : 'done';
        await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
        showToast(newStatus === 'done' ? 'Task completed' : 'Task reopened');
        loadTasks();
      } catch (err) {
        showToast(err.message);
      }
    });

    return row;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Task Loading ---
  let debounceTimer;
  async function loadTasks() {
    const params = new URLSearchParams();
    const search = filterSearch.value.trim();
    const status = filterStatus.value;
    const priority = filterPriority.value;

    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);

    const qs = params.toString();
    try {
      const tasks = await api(`/tasks${qs ? '?' + qs : ''}`);
      taskListEl.innerHTML = '';
      emptyState.hidden = tasks.length > 0;
      taskListEl.hidden = tasks.length === 0;

      for (const task of tasks) {
        taskListEl.appendChild(renderTask(task));
      }
    } catch (e) {
      showToast('Failed to load tasks');
    }
  }

  function debouncedLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadTasks, 300);
  }

  filterSearch.addEventListener('input', debouncedLoad);
  filterStatus.addEventListener('change', loadTasks);
  filterPriority.addEventListener('change', loadTasks);

  // --- Modal ---
  function openModal() {
    taskModal.hidden = false;
    taskTitleField.focus();
    adjustModalViewport();
  }

  function closeModal() {
    taskModal.hidden = true;
    taskForm.reset();
    taskIdField.value = '';
    deleteTaskBtn.hidden = true;
    taskModal.style.height = '';
    taskModal.style.top = '';
  }

  // Resize modal overlay to fit above virtual keyboard
  function adjustModalViewport() {
    if (!window.visualViewport || taskModal.hidden) return;
    const vv = window.visualViewport;
    taskModal.style.height = vv.height + 'px';
    taskModal.style.top = vv.offsetTop + 'px';
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustModalViewport);
    window.visualViewport.addEventListener('scroll', adjustModalViewport);
  }

  function openNewModal() {
    modalTitle.textContent = 'New Task';
    taskIdField.value = '';
    taskTitleField.value = '';
    taskStatusField.value = 'todo';
    taskPriorityField.value = 'medium';
    taskDueField.value = '';
    taskNotesField.value = '';
    deleteTaskBtn.hidden = true;
    openModal();
  }

  function openEditModal(task) {
    modalTitle.textContent = 'Edit Task';
    taskIdField.value = task.id;
    taskTitleField.value = task.title;
    taskStatusField.value = task.status;
    taskPriorityField.value = task.priority;
    taskDueField.value = task.dueDate || '';
    taskNotesField.value = task.notes || '';
    deleteTaskBtn.hidden = false;
    openModal();
  }

  addTaskBtn.addEventListener('click', openNewModal);
  modalClose.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) closeModal();
  });

  // --- Save Task ---
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = taskIdField.value;
    const data = {
      title: taskTitleField.value.trim(),
      status: taskStatusField.value,
      priority: taskPriorityField.value,
      dueDate: taskDueField.value || null,
      notes: taskNotesField.value.trim()
    };

    if (!data.title) return;

    try {
      if (id) {
        await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        showToast('Task updated');
      } else {
        await api('/tasks', { method: 'POST', body: JSON.stringify(data) });
        showToast('Task created');
      }
      closeModal();
      loadTasks();
    } catch (e) {
      showToast(e.message);
    }
  });

  // --- Delete Task ---
  deleteTaskBtn.addEventListener('click', async () => {
    const id = taskIdField.value;
    if (!id) return;
    if (!confirm('Delete this task?')) return;

    try {
      await api(`/tasks/${id}`, { method: 'DELETE' });
      showToast('Task deleted');
      closeModal();
      loadTasks();
    } catch (e) {
      showToast(e.message);
    }
  });

  // --- Init ---
  if (apiKey) {
    tryAuth(apiKey).catch(() => {
      authGate.hidden = false;
      mainApp.hidden = true;
    });
  }
})();
