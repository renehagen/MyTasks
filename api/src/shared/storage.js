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

  // Sort by updatedAt descending
  tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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
