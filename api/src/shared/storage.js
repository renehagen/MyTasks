const { TableClient, TableServiceClient } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');

const TABLE_NAME = 'tasks';
const PARTITION_KEY = 'task';
const SORT_ORDER_GAP = 1000;

let tableClient = null;
let tableReady = false;

function getTableClient() {
  if (!tableClient) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
    }
    tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);
  }
  return tableClient;
}

async function ensureTable() {
  if (tableReady) return;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const serviceClient = TableServiceClient.fromConnectionString(connectionString);
  try {
    await serviceClient.createTable(TABLE_NAME);
  } catch (err) {
    if (err.statusCode !== 409) throw err; // 409 = already exists
  }
  tableReady = true;
}

function nowIso() {
  return new Date().toISOString();
}

function isDeleted(entity) {
  return !!entity.deletedAt;
}

function changedSince(entity, since) {
  if (!since) return true;
  const changedAt = entity.updatedAt || entity.createdAt || '';
  return changedAt > since;
}

function isTaskEntity(entity) {
  return entity.category !== 'shopping' && entity.category !== 'list';
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeTaskListId(listId) {
  return listId ? String(listId) : '';
}

function normalizeListType(type) {
  return type === 'tasklist' ? 'tasklist' : 'checklist';
}

function sortTasks(tasks) {
  const priorityOrder = { 'high': 0, 'medium': 1, 'low': 2 };

  function sortGroup(task) {
    if (task.deletedAt) return 99;
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

  tasks.sort((a, b) => {
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
  return tasks;
}

async function getEntityOrNull(id) {
  const client = getTableClient();
  try {
    return await client.getEntity(PARTITION_KEY, id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function markDeleted(id, expectedCategory) {
  await ensureTable();
  const client = getTableClient();
  const existing = await getEntityOrNull(id);
  if (!existing || isDeleted(existing)) return false;

  if (expectedCategory === 'task' && !isTaskEntity(existing)) return false;
  if (expectedCategory && expectedCategory !== 'task' && existing.category !== expectedCategory) return false;

  const now = nowIso();
  await client.updateEntity({
    partitionKey: PARTITION_KEY,
    rowKey: id,
    updatedAt: now,
    deletedAt: now
  }, 'Merge');
  return true;
}

function entityToTask(entity) {
  const today = new Date().toISOString().slice(0, 10);
  const task = {
    id: entity.rowKey,
    listId: normalizeTaskListId(entity.listId),
    title: entity.title,
    status: entity.status,
    priority: entity.priority,
    notes: entity.notes || '',
    startDate: entity.startDate || null,
    dueDate: entity.dueDate || null,
    waiting: entity.waiting === true,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt || null
  };

  const active = task.status !== 'done' && task.status !== 'cancelled';
  if (active && task.waiting) {
    task.tag = 'waiting';
  } else if (active && task.dueDate && task.dueDate < today) {
    task.tag = 'overdue';
  } else if (active && task.startDate && task.startDate <= today) {
    task.tag = 'pending';
  } else {
    task.tag = null;
  }

  return task;
}

function entityToList(entity) {
  return {
    id: entity.rowKey,
    name: entity.name,
    type: normalizeListType(entity.type),
    sortOrder: entity.sortOrder || 0,
    hidden: entity.hidden === true,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt || null
  };
}

async function getList(id) {
  await ensureTable();
  const entity = await getEntityOrNull(id);
  if (!entity || entity.category !== 'list' || isDeleted(entity)) return null;
  return entityToList(entity);
}

async function validateTaskListId(listId) {
  if (!listId) return;
  const list = await getList(listId);
  if (!list || list.type !== 'tasklist') {
    throw badRequest('Task list not found');
  }
}

async function listTasks(filters = {}) {
  await ensureTable();
  const client = getTableClient();

  const filterParts = [`PartitionKey eq '${PARTITION_KEY}'`];
  if (filters.status) {
    filterParts.push(`status eq '${filters.status}'`);
  }
  if (filters.priority) {
    filterParts.push(`priority eq '${filters.priority}'`);
  }

  const queryFilter = filterParts.join(' and ');
  const entities = client.listEntities({ queryOptions: { filter: queryFilter } });

  const tasks = [];
  const shouldFilterList = hasOwn(filters, 'listId');
  const listId = shouldFilterList ? normalizeTaskListId(filters.listId) : null;
  for await (const entity of entities) {
    if (!isTaskEntity(entity) || isDeleted(entity)) continue;
    const task = entityToTask(entity);
    if (shouldFilterList && task.listId !== listId) continue;
    tasks.push(task);
  }

  return sortTasks(tasks);
}

async function getTask(id) {
  await ensureTable();
  const entity = await getEntityOrNull(id);
  if (!entity || !isTaskEntity(entity) || isDeleted(entity)) return null;
  return entityToTask(entity);
}

async function createTask(data) {
  await ensureTable();
  const client = getTableClient();

  const now = nowIso();
  const listId = normalizeTaskListId(data.listId);
  await validateTaskListId(listId);
  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: data.id || uuidv4(),
    listId,
    title: data.title,
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    notes: data.notes || '',
    startDate: data.startDate || '',
    dueDate: data.dueDate || '',
    waiting: data.waiting || false,
    createdAt: now,
    updatedAt: now
  };

  await client.createEntity(entity);
  return entityToTask(entity);
}

async function updateTask(id, data) {
  await ensureTable();
  const client = getTableClient();

  const existing = await getEntityOrNull(id);
  if (!existing || !isTaskEntity(existing) || isDeleted(existing)) return null;

  const listId = normalizeTaskListId(data.listId !== undefined ? data.listId : existing.listId || '');
  await validateTaskListId(listId);
  const updated = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    listId,
    title: data.title !== undefined ? data.title : existing.title,
    status: data.status !== undefined ? data.status : existing.status,
    priority: data.priority !== undefined ? data.priority : existing.priority,
    notes: data.notes !== undefined ? data.notes : existing.notes,
    startDate: data.startDate !== undefined ? data.startDate : existing.startDate,
    dueDate: data.dueDate !== undefined ? data.dueDate : existing.dueDate,
    waiting: data.waiting !== undefined ? data.waiting : existing.waiting,
    createdAt: existing.createdAt,
    updatedAt: nowIso()
  };

  await client.updateEntity(updated, 'Replace');
  return entityToTask(updated);
}

async function deleteTask(id) {
  return markDeleted(id, 'task');
}

async function searchTasks(query, filters = {}) {
  await ensureTable();
  // Azure Table Storage doesn't support contains queries natively,
  // so we fetch all and filter in memory
  const allTasks = await listTasks(filters);
  const lowerQuery = query.toLowerCase();
  return allTasks.filter(t =>
    t.title.toLowerCase().includes(lowerQuery) ||
    t.notes.toLowerCase().includes(lowerQuery)
  );
}

// --- Shopping Items ---

function entityToShoppingItem(entity) {
  return {
    id: entity.rowKey,
    listId: entity.listId || '',
    title: entity.title,
    checked: entity.checked === true,
    sortOrder: entity.sortOrder || 0,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt || null
  };
}

async function listLists(filters = {}) {
  await ensureTable();
  const client = getTableClient();
  const filter = `PartitionKey eq '${PARTITION_KEY}' and category eq 'list'`;
  const entities = client.listEntities({ queryOptions: { filter } });

  const lists = [];
  const type = filters.type ? normalizeListType(filters.type) : null;
  for await (const entity of entities) {
    if (isDeleted(entity)) continue;
    const list = entityToList(entity);
    if (type && list.type !== type) continue;
    lists.push(list);
  }
  lists.sort((a, b) => a.sortOrder - b.sortOrder);
  return lists;
}

async function createList(data) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();

  const type = normalizeListType(data.type);
  const existing = await listLists({ type });
  const maxSort = existing.reduce((max, l) => Math.max(max, l.sortOrder), 0);

  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: data.id || uuidv4(),
    category: 'list',
    name: data.name,
    type,
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : maxSort + SORT_ORDER_GAP,
    hidden: false,
    createdAt: now,
    updatedAt: now
  };

  await client.createEntity(entity);
  return entityToList(entity);
}

async function updateList(id, data) {
  await ensureTable();
  const client = getTableClient();

  let existing;
  try {
    existing = await getEntityOrNull(id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }

  if (!existing || existing.category !== 'list' || isDeleted(existing)) return null;

  const updated = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    category: 'list',
    name: data.name !== undefined ? data.name : existing.name,
    type: data.type !== undefined ? normalizeListType(data.type) : normalizeListType(existing.type),
    sortOrder: existing.sortOrder || 0,
    hidden: data.hidden !== undefined ? data.hidden === true : existing.hidden === true,
    createdAt: existing.createdAt,
    updatedAt: nowIso()
  };

  await client.updateEntity(updated, 'Replace');
  return entityToList(updated);
}

async function deleteList(id) {
  await ensureTable();

  const items = await listShoppingItems(id);
  for (const item of items) {
    await markDeleted(item.id, 'shopping');
  }

  const tasks = await listTasks({ listId: id });
  for (const task of tasks) {
    await markDeleted(task.id, 'task');
  }

  return markDeleted(id, 'list');
}

function normalizeListId(listId) {
  return listId && listId !== 'shopping' ? listId : '';
}

async function listShoppingItems(listId) {
  await ensureTable();
  const client = getTableClient();
  const filter = `PartitionKey eq '${PARTITION_KEY}' and category eq 'shopping'`;
  const entities = client.listEntities({ queryOptions: { filter } });

  const normalized = normalizeListId(listId);
  const items = [];
  for await (const entity of entities) {
    if (isDeleted(entity)) continue;
    const itemListId = entity.listId || '';
    if (itemListId !== normalized) continue;
    items.push(entityToShoppingItem(entity));
  }

  items.sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return a.sortOrder - b.sortOrder;
  });

  return items;
}

async function createShoppingItem(data) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();

  const normalized = normalizeListId(data.listId);
  const existing = await listShoppingItems(normalized);
  const minSort = existing.reduce((min, item) => Math.min(min, item.sortOrder), SORT_ORDER_GAP);

  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: data.id || uuidv4(),
    category: 'shopping',
    listId: normalized,
    title: data.title,
    checked: false,
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : minSort - SORT_ORDER_GAP,
    status: '',
    priority: '',
    notes: '',
    startDate: '',
    dueDate: '',
    createdAt: now,
    updatedAt: now
  };

  await client.createEntity(entity);
  return entityToShoppingItem(entity);
}

async function updateShoppingItem(id, data) {
  await ensureTable();
  const client = getTableClient();

  let existing;
  try {
    existing = await getEntityOrNull(id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }

  if (!existing || existing.category !== 'shopping' || isDeleted(existing)) return null;

  const updated = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    category: 'shopping',
    listId: existing.listId || '',
    title: data.title !== undefined ? data.title : existing.title,
    checked: data.checked !== undefined ? data.checked : existing.checked,
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : existing.sortOrder,
    status: existing.status || '',
    priority: existing.priority || '',
    notes: existing.notes || '',
    dueDate: existing.dueDate || '',
    createdAt: existing.createdAt,
    updatedAt: nowIso()
  };

  await client.updateEntity(updated, 'Replace');
  return entityToShoppingItem(updated);
}

async function deleteShoppingItem(id) {
  return markDeleted(id, 'shopping');
}

async function reorderShoppingItems(orderedIds, listId) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();

  const actions = [];
  for (let i = 0; i < orderedIds.length; i++) {
    actions.push(['update', {
      partitionKey: PARTITION_KEY,
      rowKey: orderedIds[i],
      sortOrder: i * SORT_ORDER_GAP,
      updatedAt: now
    }, 'Merge']);
  }

  if (actions.length > 0) {
    await client.submitTransaction(actions);
  }

  return listShoppingItems(listId);
}

async function upsertTaskFromSync(data) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();
  const id = data.id || uuidv4();
  const existing = await getEntityOrNull(id);

  if (existing && !isTaskEntity(existing)) {
    throw new Error(`Cannot sync task ${id}: ID belongs to another record type`);
  }

  const listId = normalizeTaskListId(data.listId !== undefined ? data.listId : existing?.listId || '');
  await validateTaskListId(listId);
  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    listId,
    title: data.title !== undefined ? data.title : existing?.title || '',
    status: data.status !== undefined ? data.status : existing?.status || 'todo',
    priority: data.priority !== undefined ? data.priority : existing?.priority || 'medium',
    notes: data.notes !== undefined ? data.notes : existing?.notes || '',
    startDate: data.startDate !== undefined ? data.startDate || '' : existing?.startDate || '',
    dueDate: data.dueDate !== undefined ? data.dueDate || '' : existing?.dueDate || '',
    waiting: data.waiting !== undefined ? data.waiting === true : existing?.waiting === true,
    createdAt: existing?.createdAt || data.createdAt || now,
    updatedAt: now,
    deletedAt: ''
  };

  await client.upsertEntity(entity, 'Replace');
  return entityToTask(entity);
}

async function upsertListFromSync(data) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();
  const id = data.id || uuidv4();
  const existing = await getEntityOrNull(id);

  if (existing && existing.category !== 'list') {
    throw new Error(`Cannot sync list ${id}: ID belongs to another record type`);
  }

  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    category: 'list',
    name: data.name !== undefined ? data.name : existing?.name || '',
    type: data.type !== undefined ? normalizeListType(data.type) : normalizeListType(existing?.type),
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : existing?.sortOrder || 0,
    hidden: data.hidden !== undefined ? data.hidden === true : existing?.hidden === true,
    createdAt: existing?.createdAt || data.createdAt || now,
    updatedAt: now,
    deletedAt: ''
  };

  await client.upsertEntity(entity, 'Replace');
  return entityToList(entity);
}

async function upsertShoppingItemFromSync(data) {
  await ensureTable();
  const client = getTableClient();
  const now = nowIso();
  const id = data.id || uuidv4();
  const existing = await getEntityOrNull(id);

  if (existing && existing.category !== 'shopping') {
    throw new Error(`Cannot sync shopping item ${id}: ID belongs to another record type`);
  }

  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    category: 'shopping',
    listId: normalizeListId(data.listId !== undefined ? data.listId : existing?.listId || ''),
    title: data.title !== undefined ? data.title : existing?.title || '',
    checked: data.checked !== undefined ? data.checked === true : existing?.checked === true,
    sortOrder: data.sortOrder !== undefined ? data.sortOrder : existing?.sortOrder || 0,
    status: existing?.status || '',
    priority: existing?.priority || '',
    notes: existing?.notes || '',
    startDate: existing?.startDate || '',
    dueDate: existing?.dueDate || '',
    createdAt: existing?.createdAt || data.createdAt || now,
    updatedAt: now,
    deletedAt: ''
  };

  await client.upsertEntity(entity, 'Replace');
  return entityToShoppingItem(entity);
}

async function listChanges(since) {
  await ensureTable();
  const client = getTableClient();
  const filter = `PartitionKey eq '${PARTITION_KEY}'`;
  const entities = client.listEntities({ queryOptions: { filter } });

  const changes = {
    tasks: [],
    lists: [],
    shoppingItems: []
  };

  for await (const entity of entities) {
    if (!changedSince(entity, since)) continue;

    if (entity.category === 'list') {
      changes.lists.push(entityToList(entity));
    } else if (entity.category === 'shopping') {
      changes.shoppingItems.push(entityToShoppingItem(entity));
    } else {
      changes.tasks.push(entityToTask(entity));
    }
  }

  sortTasks(changes.tasks);
  changes.lists.sort((a, b) => a.sortOrder - b.sortOrder);
  changes.shoppingItems.sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return a.sortOrder - b.sortOrder;
  });

  return changes;
}

module.exports = {
  listTasks, getTask, createTask, updateTask, deleteTask, searchTasks,
  listShoppingItems, createShoppingItem, updateShoppingItem, deleteShoppingItem, reorderShoppingItems,
  listLists, getList, createList, updateList, deleteList,
  upsertTaskFromSync, upsertListFromSync, upsertShoppingItemFromSync, listChanges
};
