const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

// GET /api/lists
app.http('listLists', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lists',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const lists = await storage.listLists();
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
      const list = await storage.createList({ name });
      return { status: 201, jsonBody: list };
    } catch (err) {
      context.error('createList error:', err);
      return { status: 500, jsonBody: { error: 'Failed to create list' } };
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
