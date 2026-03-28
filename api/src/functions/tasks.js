const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

const VALID_STATUSES = ['backlog', 'todo', 'in-progress', 'done', 'cancelled'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

// GET /api/tasks
app.http('listTasks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tasks',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const status = request.query.get('status');
      const priority = request.query.get('priority');
      const search = request.query.get('search');

      let tasks;
      if (search) {
        tasks = await storage.searchTasks(search);
        if (status) tasks = tasks.filter(t => t.status === status);
        if (priority) tasks = tasks.filter(t => t.priority === priority);
      } else {
        tasks = await storage.listTasks({ status, priority });
      }

      return { jsonBody: tasks };
    } catch (err) {
      context.error('listTasks error:', err);
      return { status: 500, jsonBody: { error: 'Failed to list tasks' } };
    }
  }
});

// GET /api/tasks/:id
app.http('getTask', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tasks/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const task = await storage.getTask(id);
      if (!task) {
        return { status: 404, jsonBody: { error: 'Task not found' } };
      }
      return { jsonBody: task };
    } catch (err) {
      context.error('getTask error:', err);
      return { status: 500, jsonBody: { error: 'Failed to get task' } };
    }
  }
});

// POST /api/tasks
app.http('createTask', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'tasks',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();

      if (!body.title || !body.title.trim()) {
        return { status: 400, jsonBody: { error: 'Title is required' } };
      }
      if (body.status && !VALID_STATUSES.includes(body.status)) {
        return { status: 400, jsonBody: { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` } };
      }
      if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
        return { status: 400, jsonBody: { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` } };
      }

      const task = await storage.createTask({
        title: body.title.trim(),
        status: body.status,
        priority: body.priority,
        notes: body.notes,
        startDate: body.startDate,
        dueDate: body.dueDate,
        waiting: body.waiting
      });

      return { status: 201, jsonBody: task };
    } catch (err) {
      context.error('createTask error:', err);
      return { status: 500, jsonBody: { error: 'Failed to create task' } };
    }
  }
});

// PUT /api/tasks/:id
app.http('updateTask', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'tasks/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const body = await request.json();

      if (body.status && !VALID_STATUSES.includes(body.status)) {
        return { status: 400, jsonBody: { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` } };
      }
      if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
        return { status: 400, jsonBody: { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` } };
      }

      const task = await storage.updateTask(id, {
        title: body.title?.trim(),
        status: body.status,
        priority: body.priority,
        notes: body.notes,
        startDate: body.startDate,
        dueDate: body.dueDate,
        waiting: body.waiting
      });

      if (!task) {
        return { status: 404, jsonBody: { error: 'Task not found' } };
      }

      return { jsonBody: task };
    } catch (err) {
      if (err.statusCode === 404) {
        return { status: 404, jsonBody: { error: 'Task not found' } };
      }
      context.error('updateTask error:', err);
      return { status: 500, jsonBody: { error: 'Failed to update task' } };
    }
  }
});

// DELETE /api/tasks/:id
app.http('deleteTask', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'tasks/{id}',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const id = request.params.id;
      const deleted = await storage.deleteTask(id);
      if (!deleted) {
        return { status: 404, jsonBody: { error: 'Task not found' } };
      }
      return { jsonBody: { message: 'Task deleted' } };
    } catch (err) {
      context.error('deleteTask error:', err);
      return { status: 500, jsonBody: { error: 'Failed to delete task' } };
    }
  }
});
