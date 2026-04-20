const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

// GET /api/shopping
app.http('listShopping', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'shopping',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const listId = request.query.get('listId') || '';
      const items = await storage.listShoppingItems(listId);
      return { jsonBody: items };
    } catch (err) {
      context.error('listShopping error:', err);
      return { status: 500, jsonBody: { error: 'Failed to list shopping items' } };
    }
  }
});

// POST /api/shopping
app.http('createShopping', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'shopping',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();
      if (!body.title || !body.title.trim()) {
        return { status: 400, jsonBody: { error: 'Title is required' } };
      }
      const item = await storage.createShoppingItem({
        title: body.title.trim(),
        listId: body.listId || ''
      });
      return { status: 201, jsonBody: item };
    } catch (err) {
      context.error('createShopping error:', err);
      return { status: 500, jsonBody: { error: 'Failed to create shopping item' } };
    }
  }
});

// PUT /api/shopping/reorder — must be registered BEFORE shopping/{id}
app.http('reorderShopping', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'shopping/reorder',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();
      if (!Array.isArray(body.orderedIds)) {
        return { status: 400, jsonBody: { error: 'orderedIds array is required' } };
      }
      const items = await storage.reorderShoppingItems(body.orderedIds, body.listId || '');
      return { jsonBody: items };
    } catch (err) {
      context.error('reorderShopping error:', err);
      return { status: 500, jsonBody: { error: 'Failed to reorder shopping items' } };
    }
  }
});

// PUT /api/shopping/:id
app.http('updateShopping', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'shopping/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const body = await request.json();
      const item = await storage.updateShoppingItem(id, {
        title: body.title?.trim(),
        checked: body.checked
      });
      if (!item) {
        return { status: 404, jsonBody: { error: 'Item not found' } };
      }
      return { jsonBody: item };
    } catch (err) {
      if (err.statusCode === 404) {
        return { status: 404, jsonBody: { error: 'Item not found' } };
      }
      context.error('updateShopping error:', err);
      return { status: 500, jsonBody: { error: 'Failed to update shopping item' } };
    }
  }
});

// DELETE /api/shopping/:id
app.http('deleteShopping', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'shopping/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const deleted = await storage.deleteTask(id);
      if (!deleted) {
        return { status: 404, jsonBody: { error: 'Item not found' } };
      }
      return { jsonBody: { message: 'Item deleted' } };
    } catch (err) {
      context.error('deleteShopping error:', err);
      return { status: 500, jsonBody: { error: 'Failed to delete shopping item' } };
    }
  }
});
