const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

const VALID_LIST_TYPES = ['checklist', 'tasklist'];

function validateListType(type) {
  if (type === undefined || type === null || type === '') return null;
  if (!VALID_LIST_TYPES.includes(type)) {
    return { status: 400, jsonBody: { error: `Invalid type. Must be one of: ${VALID_LIST_TYPES.join(', ')}` } };
  }
  return null;
}

// GET /api/lists
app.http('listLists', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lists',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const type = request.query.get('type');
      const invalidType = validateListType(type);
      if (invalidType) return invalidType;
      const lists = await storage.listLists(type ? { type } : {});
      return { jsonBody: lists };
    } catch (err) {
      context.error('listLists error:', err);
      return { status: 500, jsonBody: { error: 'Failed to list lists' } };
    }
  }
});

// POST /api/lists
app.http('createList', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'lists',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();
      const name = (body.name || '').trim();
      if (!name) {
        return { status: 400, jsonBody: { error: 'Name is required' } };
      }
      const invalidType = validateListType(body.type);
      if (invalidType) return invalidType;
      const list = await storage.createList({ name, type: body.type || 'checklist' });
      return { status: 201, jsonBody: list };
    } catch (err) {
      context.error('createList error:', err);
      return { status: 500, jsonBody: { error: 'Failed to create list' } };
    }
  }
});

// PUT /api/lists/:id
app.http('updateList', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'lists/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const body = await request.json();
      const data = {};

      if (body.name !== undefined) {
        const name = (body.name || '').trim();
        if (!name) {
          return { status: 400, jsonBody: { error: 'Name is required' } };
        }
        data.name = name;
      }

      if (body.hidden !== undefined) {
        if (typeof body.hidden !== 'boolean') {
          return { status: 400, jsonBody: { error: 'Hidden must be a boolean' } };
        }
        data.hidden = body.hidden;
      }

      if (body.type !== undefined) {
        const invalidType = validateListType(body.type);
        if (invalidType) return invalidType;
        data.type = body.type;
      }

      if (Object.keys(data).length === 0) {
        return { status: 400, jsonBody: { error: 'No updates provided' } };
      }

      const list = await storage.updateList(id, data);
      if (!list) {
        return { status: 404, jsonBody: { error: 'List not found' } };
      }
      return { jsonBody: list };
    } catch (err) {
      context.error('updateList error:', err);
      return { status: 500, jsonBody: { error: 'Failed to update list' } };
    }
  }
});

// DELETE /api/lists/:id
app.http('deleteList', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'lists/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const deleted = await storage.deleteList(id);
      if (!deleted) {
        return { status: 404, jsonBody: { error: 'List not found' } };
      }
      return { jsonBody: { message: 'List deleted' } };
    } catch (err) {
      context.error('deleteList error:', err);
      return { status: 500, jsonBody: { error: 'Failed to delete list' } };
    }
  }
});
