const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

const VALID_ENTITY_TYPES = ['task', 'list', 'shopping'];
const VALID_ACTIONS = ['upsert', 'delete'];

function badRequest(message) {
  return { status: 400, jsonBody: { error: message } };
}

function normalizeOperation(operation) {
  const entityType = operation.entityType;
  const action = operation.action;
  const data = operation.data || {};
  const entityId = operation.entityId || data.id;

  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    throw new Error(`Invalid entityType: ${entityType}`);
  }
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  if (!entityId) {
    throw new Error('Operation entityId is required');
  }

  return {
    entityType,
    action,
    entityId,
    data: { ...data, id: entityId }
  };
}

async function applyOperation(operation) {
  const op = normalizeOperation(operation);

  if (op.action === 'delete') {
    if (op.entityType === 'task') return storage.deleteTask(op.entityId);
    if (op.entityType === 'list') return storage.deleteList(op.entityId);
    return storage.deleteShoppingItem(op.entityId);
  }

  if (op.entityType === 'task') return storage.upsertTaskFromSync(op.data);
  if (op.entityType === 'list') return storage.upsertListFromSync(op.data);
  return storage.upsertShoppingItemFromSync(op.data);
}

// POST /api/sync
app.http('sync', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'sync',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();
      const operations = Array.isArray(body.operations) ? body.operations : [];

      for (const operation of operations) {
        await applyOperation(operation);
      }

      const serverTime = new Date().toISOString();
      const changes = await storage.listChanges(body.lastPulledAt || null);

      return {
        jsonBody: {
          serverTime,
          appliedOperationIds: operations.map(op => op.id).filter(Boolean),
          changes
        }
      };
    } catch (err) {
      if (err.message && (err.message.startsWith('Invalid ') || err.message.includes('required'))) {
        return badRequest(err.message);
      }
      context.error('sync error:', err);
      return { status: 500, jsonBody: { error: 'Failed to sync changes' } };
    }
  }
});
