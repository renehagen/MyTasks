(function () {
  'use strict';

  const DB_NAME = 'mytasks-local';
  const DB_VERSION = 1;
  const SORT_ORDER_GAP = 1000;
  const STORES = ['tasks', 'lists', 'shoppingItems', 'outbox', 'meta'];

  let dbPromise = null;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('shoppingItems')) db.createObjectStore('shoppingItems', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function randomId(prefix) {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${id}`;
  }

  function normalizeListId(listId) {
    return listId && listId !== 'shopping' ? listId : '';
  }

  function normalizeTask(task) {
    return {
      id: task.id,
      title: task.title || '',
      status: task.status || 'todo',
      priority: task.priority || 'medium',
      notes: task.notes || '',
      startDate: task.startDate || null,
      dueDate: task.dueDate || null,
      waiting: task.waiting === true,
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
      deletedAt: task.deletedAt || null
    };
  }

  function decorateTask(task) {
    const normalized = normalizeTask(task);
    const today = new Date().toISOString().slice(0, 10);
    const active = normalized.status !== 'done' && normalized.status !== 'cancelled';

    if (active && normalized.waiting) {
      normalized.tag = 'waiting';
    } else if (active && normalized.dueDate && normalized.dueDate < today) {
      normalized.tag = 'overdue';
    } else if (active && normalized.startDate && normalized.startDate <= today) {
      normalized.tag = 'pending';
    } else {
      normalized.tag = null;
    }

    return normalized;
  }

  function sortTasks(tasks) {
    const priorityOrder = { high: 0, medium: 1, low: 2 };

    function sortGroup(task) {
      if (task.tag === 'overdue') return 0;
      if (task.tag === 'pending') return 1;
      if (task.tag === 'waiting') return 2;
      const active = task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'backlog';
      if (active && task.dueDate) return 3;
      if (task.status === 'in-progress') return 4;
      if (task.status === 'todo') return 5;
      if (task.status === 'done' || task.status === 'cancelled') return 6;
      if (task.status === 'backlog') return 7;
      return 8;
    }

    return tasks.sort((a, b) => {
      const ga = sortGroup(a);
      const gb = sortGroup(b);
      if (ga !== gb) return ga - gb;

      const aHasDue = !!a.dueDate;
      const bHasDue = !!b.dueDate;
      if (aHasDue !== bHasDue) return aHasDue ? -1 : 1;

      if (aHasDue && bHasDue) {
        const cmp = a.dueDate.localeCompare(b.dueDate);
        if (cmp !== 0) return cmp;
      }

      const pa = priorityOrder[a.priority] ?? 9;
      const pb = priorityOrder[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;

      return 0;
    });
  }

  function sortLists(lists) {
    return lists.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }

  function sortShoppingItems(items) {
    return items.sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readonly');
    return requestToPromise(tx.objectStore(storeName).getAll());
  }

  async function getOne(storeName, id) {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readonly');
    return requestToPromise(tx.objectStore(storeName).get(id));
  }

  async function putOne(storeName, value) {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    await txDone(tx);
    return value;
  }

  async function deleteOne(storeName, id) {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    await txDone(tx);
  }

  async function setMeta(key, value) {
    await putOne('meta', { key, value });
  }

  async function getMeta(key) {
    const entry = await getOne('meta', key);
    return entry ? entry.value : null;
  }

  async function queueMutation(entityType, entityId, action, data) {
    const now = nowIso();
    const db = await openDb();
    const tx = db.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const existingOps = await requestToPromise(store.getAll());
    const existing = existingOps.find(op => op.entityType === entityType && op.entityId === entityId);

    if (existing) {
      existing.action = action;
      existing.data = action === 'delete' ? { id: entityId } : { ...(existing.data || {}), ...data, id: entityId };
      existing.updatedAt = now;
      store.put(existing);
    } else {
      store.put({
        id: randomId('op'),
        entityType,
        entityId,
        action,
        data: action === 'delete' ? { id: entityId } : { ...data, id: entityId },
        createdAt: now,
        updatedAt: now
      });
    }

    await txDone(tx);
  }

  async function listTasks(filters = {}) {
    let tasks = (await getAll('tasks'))
      .filter(task => !task.deletedAt)
      .map(decorateTask);

    if (filters.status) tasks = tasks.filter(task => task.status === filters.status);
    if (filters.priority) tasks = tasks.filter(task => task.priority === filters.priority);
    if (filters.search) {
      const query = filters.search.toLowerCase();
      tasks = tasks.filter(task =>
        task.title.toLowerCase().includes(query) ||
        task.notes.toLowerCase().includes(query)
      );
    }

    return sortTasks(tasks);
  }

  async function getTask(id) {
    const task = await getOne('tasks', id);
    return task && !task.deletedAt ? decorateTask(task) : null;
  }

  async function saveTask(data, id) {
    const now = nowIso();
    const existing = id ? await getOne('tasks', id) : null;
    if (id && (!existing || existing.deletedAt)) return null;
    const task = normalizeTask({
      ...existing,
      ...data,
      id: id || randomId('task'),
      title: data.title !== undefined ? data.title : existing?.title,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deletedAt: null
    });

    await putOne('tasks', task);
    await queueMutation('task', task.id, 'upsert', task);
    return decorateTask(task);
  }

  async function deleteTask(id) {
    const existing = await getOne('tasks', id);
    if (!existing) return false;

    const now = nowIso();
    await putOne('tasks', { ...existing, updatedAt: now, deletedAt: now });
    await queueMutation('task', id, 'delete', { id });
    return true;
  }

  async function listLists() {
    return sortLists((await getAll('lists')).filter(list => !list.deletedAt));
  }

  async function saveList(data, id) {
    const now = nowIso();
    const existing = id ? await getOne('lists', id) : null;
    if (id && (!existing || existing.deletedAt)) return null;
    const lists = await listLists();
    const maxSort = lists.reduce((max, list) => Math.max(max, list.sortOrder || 0), 0);
    const list = {
      ...existing,
      id: id || randomId('list'),
      name: data.name !== undefined ? data.name : existing?.name || '',
      sortOrder: data.sortOrder !== undefined ? data.sortOrder : (existing?.sortOrder ?? maxSort + SORT_ORDER_GAP),
      hidden: data.hidden !== undefined ? data.hidden === true : existing?.hidden === true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deletedAt: null
    };

    await putOne('lists', list);
    await queueMutation('list', list.id, 'upsert', list);
    return list;
  }

  async function deleteList(id) {
    const existing = await getOne('lists', id);
    if (!existing) return false;

    const now = nowIso();
    await putOne('lists', { ...existing, updatedAt: now, deletedAt: now });

    const items = await getAll('shoppingItems');
    for (const item of items.filter(item => normalizeListId(item.listId) === id && !item.deletedAt)) {
      await putOne('shoppingItems', { ...item, updatedAt: now, deletedAt: now });
    }

    await queueMutation('list', id, 'delete', { id });
    return true;
  }

  async function listShoppingItems(listId) {
    const normalized = normalizeListId(listId);
    const items = (await getAll('shoppingItems'))
      .filter(item => !item.deletedAt && normalizeListId(item.listId) === normalized);
    return sortShoppingItems(items);
  }

  async function saveShoppingItem(data, id) {
    const now = nowIso();
    const existing = id ? await getOne('shoppingItems', id) : null;
    if (id && (!existing || existing.deletedAt)) return null;
    const normalized = normalizeListId(data.listId !== undefined ? data.listId : existing?.listId || '');
    const items = await listShoppingItems(normalized);
    const minSort = items.reduce((min, item) => Math.min(min, item.sortOrder || 0), SORT_ORDER_GAP);
    const item = {
      ...existing,
      id: id || randomId('item'),
      listId: normalized,
      title: data.title !== undefined ? data.title : existing?.title || '',
      checked: data.checked !== undefined ? data.checked === true : existing?.checked === true,
      sortOrder: data.sortOrder !== undefined ? data.sortOrder : (existing?.sortOrder ?? minSort - SORT_ORDER_GAP),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deletedAt: null
    };

    await putOne('shoppingItems', item);
    await queueMutation('shopping', item.id, 'upsert', item);
    return item;
  }

  async function deleteShoppingItem(id) {
    const existing = await getOne('shoppingItems', id);
    if (!existing) return false;

    const now = nowIso();
    await putOne('shoppingItems', { ...existing, updatedAt: now, deletedAt: now });
    await queueMutation('shopping', id, 'delete', { id });
    return true;
  }

  async function reorderShoppingItems(orderedIds, listId) {
    const normalized = normalizeListId(listId);
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await getOne('shoppingItems', orderedIds[i]);
      if (!item || item.deletedAt || normalizeListId(item.listId) !== normalized) continue;
      await saveShoppingItem({ sortOrder: i * SORT_ORDER_GAP }, item.id);
    }
    return listShoppingItems(normalized);
  }

  async function applyRemoteCollection(storeName, records) {
    for (const record of records || []) {
      if (record.deletedAt) {
        await deleteOne(storeName, record.id);
      } else {
        await putOne(storeName, record);
      }
    }
  }

  async function removeOutbox(ids) {
    for (const id of ids) {
      await deleteOne('outbox', id);
    }
  }

  async function applySyncResult(result, sentOperationIds) {
    if (!result || !result.changes) return;

    await applyRemoteCollection('tasks', result.changes.tasks);
    await applyRemoteCollection('lists', result.changes.lists);
    await applyRemoteCollection('shoppingItems', result.changes.shoppingItems);
    await removeOutbox(sentOperationIds || result.appliedOperationIds || []);

    if (result.serverTime) {
      await setMeta('lastPulledAt', result.serverTime);
    }
  }

  async function hasLocalData() {
    for (const store of ['tasks', 'lists', 'shoppingItems', 'outbox']) {
      if ((await getAll(store)).length > 0) return true;
    }
    return !!(await getMeta('lastPulledAt'));
  }

  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(STORES, 'readwrite');
    for (const store of STORES) {
      tx.objectStore(store).clear();
    }
    await txDone(tx);
  }

  window.MyTasksLocal = {
    init: openDb,
    getMeta,
    setMeta,
    hasLocalData,
    clearAll,
    getPendingOperations: async () => (await getAll('outbox')).sort((a, b) => {
      const created = a.createdAt.localeCompare(b.createdAt);
      return created !== 0 ? created : a.updatedAt.localeCompare(b.updatedAt);
    }),
    listTasks,
    getTask,
    saveTask,
    deleteTask,
    listLists,
    saveList,
    deleteList,
    listShoppingItems,
    saveShoppingItem,
    deleteShoppingItem,
    reorderShoppingItems,
    applySyncResult
  };
})();
