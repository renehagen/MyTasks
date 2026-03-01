(function () {
  'use strict';

  const API_BASE = '/api';
  let apiKey = localStorage.getItem('mytasks_api_key') || '';

  // --- DOM refs ---
  const splash = document.getElementById('splash');
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

  // Tab navigation
  const headerTabs = document.querySelectorAll('.tab');
  const tasksView = document.getElementById('tasks-view');
  const shoppingView = document.getElementById('shopping-view');

  // Shopping view
  const shoppingAddInput = document.getElementById('shopping-add-input');
  const shoppingListEl = document.getElementById('shopping-list');
  const shoppingEmpty = document.getElementById('shopping-empty');

  let currentView = 'shopping';

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
      const error = new Error(err.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
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
  async function tryAuth(key, isAutoLogin) {
    apiKey = key;
    try {
      await api('/tasks');
      localStorage.setItem('mytasks_api_key', key);
      authGate.hidden = true;
      mainApp.hidden = false;
      loadShoppingItems();
    } catch (e) {
      if (e.status === 401) {
        // Definitive auth failure - clear saved key
        apiKey = '';
        localStorage.removeItem('mytasks_api_key');
        throw new Error('Invalid API key');
      }
      // Server/network error - keep key for retry if auto-login
      if (isAutoLogin) {
        apiKey = key;
        throw new Error('Server unavailable');
      }
      apiKey = '';
      throw new Error(e.message || 'Connection failed');
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
    splash.hidden = true;
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
  }

  function closeModal() {
    taskModal.hidden = true;
    taskForm.reset();
    taskIdField.value = '';
    deleteTaskBtn.hidden = true;
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

  // When keyboard opens on mobile, scroll modal so Save button stays visible
  const modalEl = taskModal.querySelector('.modal');
  function scrollModalToBottom() {
    if (!taskModal.hidden) {
      modalEl.scrollTop = modalEl.scrollHeight;
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scrollModalToBottom);
  }
  taskForm.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) {
      setTimeout(scrollModalToBottom, 300);
    }
  });

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

  // --- Tab Navigation ---
  headerTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      if (view === currentView) return;
      currentView = view;
      headerTabs.forEach(t => t.classList.toggle('active', t.dataset.view === view));
      if (view === 'tasks') {
        tasksView.hidden = false;
        shoppingView.hidden = true;
        loadTasks();
      } else {
        tasksView.hidden = true;
        shoppingView.hidden = false;
        loadShoppingItems();
      }
    });
  });

  // --- Shopping List ---
  function renderShoppingItem(item) {
    const row = document.createElement('div');
    row.className = 'shopping-item' + (item.checked ? ' checked-item' : '');
    row.dataset.id = item.id;
    row.dataset.sortOrder = item.sortOrder;

    row.innerHTML = `
      <span class="shopping-item-handle" title="Drag to reorder">&#x2630;</span>
      <button class="shopping-item-check${item.checked ? ' checked' : ''}"
              title="${item.checked ? 'Uncheck' : 'Check'}">&#x2713;</button>
      <span class="shopping-item-title">${escapeHtml(item.title)}</span>
      <button class="shopping-item-delete" title="Remove">&#x2715;</button>
    `;

    row.querySelector('.shopping-item-check').addEventListener('click', async () => {
      try {
        await api(`/shopping/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify({ checked: !item.checked })
        });
        loadShoppingItems();
      } catch (err) {
        showToast(err.message);
      }
    });

    row.querySelector('.shopping-item-delete').addEventListener('click', async () => {
      try {
        await api(`/shopping/${item.id}`, { method: 'DELETE' });
        showToast('Item removed');
        loadShoppingItems();
      } catch (err) {
        showToast(err.message);
      }
    });

    return row;
  }

  async function loadShoppingItems() {
    try {
      const items = await api('/shopping');
      shoppingListEl.innerHTML = '';
      shoppingEmpty.hidden = items.length > 0;

      const unchecked = items.filter(i => !i.checked);
      const checked = items.filter(i => i.checked);

      for (const item of unchecked) {
        shoppingListEl.appendChild(renderShoppingItem(item));
      }

      if (checked.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'shopping-divider';
        divider.innerHTML = `
          <span>${checked.length} checked</span>
          <button class="clear-checked-btn">Clear all</button>
        `;
        shoppingListEl.appendChild(divider);

        divider.querySelector('.clear-checked-btn').addEventListener('click', async () => {
          if (!confirm('Remove all checked items?')) return;
          try {
            await Promise.all(checked.map(item =>
              api(`/shopping/${item.id}`, { method: 'DELETE' })
            ));
            showToast('Checked items cleared');
            loadShoppingItems();
          } catch (err) {
            showToast(err.message);
          }
        });

        for (const item of checked) {
          shoppingListEl.appendChild(renderShoppingItem(item));
        }
      }

      initDragHandlers();
    } catch (err) {
      showToast('Failed to load shopping list');
    }
  }

  // Inline add
  shoppingAddInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const title = shoppingAddInput.value.trim();
    if (!title) return;

    try {
      shoppingAddInput.disabled = true;
      await api('/shopping', { method: 'POST', body: JSON.stringify({ title }) });
      shoppingAddInput.value = '';
      loadShoppingItems();
    } catch (err) {
      showToast(err.message);
    } finally {
      shoppingAddInput.disabled = false;
      shoppingAddInput.focus();
    }
  });

  // --- Drag to Reorder ---
  let dragState = null;

  function initDragHandlers() {
    const handles = shoppingListEl.querySelectorAll('.shopping-item:not(.checked-item) .shopping-item-handle');
    handles.forEach(handle => {
      handle.addEventListener('pointerdown', onDragStart);
    });
  }

  function onDragStart(e) {
    if (e.button !== 0) return;

    const itemEl = e.target.closest('.shopping-item');
    if (!itemEl || itemEl.classList.contains('checked-item')) return;

    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);

    const rect = itemEl.getBoundingClientRect();
    const allItems = Array.from(
      shoppingListEl.querySelectorAll('.shopping-item:not(.checked-item)')
    );

    dragState = {
      pointerId: e.pointerId,
      itemEl: itemEl,
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      ghost: null,
      items: allItems,
      itemRects: allItems.map(el => el.getBoundingClientRect()),
      currentIndex: allItems.indexOf(itemEl),
      originalIndex: allItems.indexOf(itemEl)
    };

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = itemEl.querySelector('.shopping-item-title').textContent;
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = (e.clientY - dragState.offsetY) + 'px';
    document.body.appendChild(ghost);
    dragState.ghost = ghost;

    itemEl.classList.add('dragging');

    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';

    let newIndex = dragState.currentIndex;
    for (let i = 0; i < dragState.itemRects.length; i++) {
      const midY = dragState.itemRects[i].top + dragState.itemRects[i].height / 2;
      if (e.clientY < midY) {
        newIndex = i;
        break;
      }
      newIndex = i + 1;
    }
    newIndex = Math.max(0, Math.min(newIndex, dragState.items.length - 1));

    if (newIndex !== dragState.currentIndex) {
      const movingEl = dragState.itemEl;
      if (newIndex < dragState.currentIndex) {
        shoppingListEl.insertBefore(movingEl, dragState.items[newIndex]);
      } else {
        const refEl = dragState.items[newIndex];
        shoppingListEl.insertBefore(movingEl, refEl.nextSibling);
      }

      dragState.items = Array.from(
        shoppingListEl.querySelectorAll('.shopping-item:not(.checked-item)')
      );
      dragState.itemRects = dragState.items.map(el => el.getBoundingClientRect());
      dragState.currentIndex = dragState.items.indexOf(movingEl);
    }
  }

  async function onDragEnd(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragEnd);

    dragState.itemEl.classList.remove('dragging');
    dragState.ghost.remove();

    if (dragState.currentIndex !== dragState.originalIndex) {
      const orderedIds = dragState.items.map(el => el.dataset.id);
      try {
        await api('/shopping/reorder', {
          method: 'PUT',
          body: JSON.stringify({ orderedIds })
        });
      } catch (err) {
        showToast('Failed to save order');
        loadShoppingItems();
      }
    }

    dragState = null;
  }

  // --- Init ---
  if (apiKey) {
    splash.hidden = false;
    (async function autoLogin() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await tryAuth(apiKey, true);
          splash.hidden = true;
          return;
        } catch (e) {
          if (e.message === 'Invalid API key') break;
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
      }
      splash.hidden = true;
      authGate.hidden = false;
      mainApp.hidden = true;
    })();
  } else {
    authGate.hidden = false;
  }
})();
