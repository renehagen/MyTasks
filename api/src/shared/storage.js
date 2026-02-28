const { TableClient, TableServiceClient } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');

const TABLE_NAME = 'tasks';
const PARTITION_KEY = 'task';

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

function entityToTask(entity) {
  return {
    id: entity.rowKey,
    title: entity.title,
    status: entity.status,
    priority: entity.priority,
    notes: entity.notes || '',
    dueDate: entity.dueDate || null,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };
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
  for await (const entity of entities) {
    tasks.push(entityToTask(entity));
  }

  const priorityOrder = { 'high': 0, 'medium': 1, 'low': 2 };
  const today = new Date().toISOString().slice(0, 10);

  function sortGroup(task) {
    const active = task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'backlog';
    const overdue = active && task.dueDate && task.dueDate < today;
    if (overdue) return 0;
    if (task.status === 'in-progress') return 1;
    if (task.status === 'todo') return 2;
    if (task.status === 'done' || task.status === 'cancelled') return 3;
    if (task.status === 'backlog') return 4;
    return 5;
  }

  tasks.sort((a, b) => {
    // 1. Sort group: overdue > in-progress > todo > done/cancelled > backlog
    const ga = sortGroup(a);
    const gb = sortGroup(b);
    if (ga !== gb) return ga - gb;

    // 2. Tasks with due date before tasks without
    const aHasDue = !!a.dueDate;
    const bHasDue = !!b.dueDate;
    if (aHasDue !== bHasDue) return aHasDue ? -1 : 1;

    // 3. Due date ascending (earliest first)
    if (aHasDue && bHasDue) {
      const cmp = a.dueDate.localeCompare(b.dueDate);
      if (cmp !== 0) return cmp;
    }

    // 4. Priority: high > medium > low
    const pa = priorityOrder[a.priority] ?? 9;
    const pb = priorityOrder[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;

    return 0;
  });
  return tasks;
}

async function getTask(id) {
  await ensureTable();
  const client = getTableClient();
  try {
    const entity = await client.getEntity(PARTITION_KEY, id);
    return entityToTask(entity);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function createTask(data) {
  await ensureTable();
  const client = getTableClient();

  const now = new Date().toISOString();
  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: uuidv4(),
    title: data.title,
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    notes: data.notes || '',
    dueDate: data.dueDate || '',
    createdAt: now,
    updatedAt: now
  };

  await client.createEntity(entity);
  return entityToTask(entity);
}

async function updateTask(id, data) {
  await ensureTable();
  const client = getTableClient();

  const existing = await client.getEntity(PARTITION_KEY, id);
  if (!existing) return null;

  const updated = {
    partitionKey: PARTITION_KEY,
    rowKey: id,
    title: data.title !== undefined ? data.title : existing.title,
    status: data.status !== undefined ? data.status : existing.status,
    priority: data.priority !== undefined ? data.priority : existing.priority,
    notes: data.notes !== undefined ? data.notes : existing.notes,
    dueDate: data.dueDate !== undefined ? data.dueDate : existing.dueDate,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString()
  };

  await client.updateEntity(updated, 'Replace');
  return entityToTask(updated);
}

async function deleteTask(id) {
  await ensureTable();
  const client = getTableClient();
  try {
    await client.deleteEntity(PARTITION_KEY, id);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

async function searchTasks(query) {
  await ensureTable();
  // Azure Table Storage doesn't support contains queries natively,
  // so we fetch all and filter in memory
  const allTasks = await listTasks();
  const lowerQuery = query.toLowerCase();
  return allTasks.filter(t =>
    t.title.toLowerCase().includes(lowerQuery) ||
    t.notes.toLowerCase().includes(lowerQuery)
  );
}

module.exports = { listTasks, getTask, createTask, updateTask, deleteTask, searchTasks };
