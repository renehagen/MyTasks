const { app } = require('@azure/functions');
const { validateApiKey, unauthorizedResponse } = require('../shared/auth');
const storage = require('../shared/storage');

const SERVER_INFO = {
  name: 'mytasks',
  version: '1.0.0'
};

const PROTOCOL_VERSION = '2025-03-26';

const TOOL_DEFINITIONS = [
  {
    name: 'list_tasks',
    description: 'List all tasks, optionally filtered by status and/or priority.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in-progress', 'done', 'cancelled'],
          description: 'Filter by task status'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Filter by task priority'
        }
      }
    }
  },
  {
    name: 'get_task',
    description: 'Get a specific task by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in-progress', 'done', 'cancelled'],
          description: 'Task status (default: todo)'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Task priority (default: medium)'
        },
        notes: { type: 'string', description: 'Additional notes' },
        startDate: { type: 'string', description: 'Start date ("do date") in YYYY-MM-DD format' },
        dueDate: { type: 'string', description: 'Due date (hard deadline) in YYYY-MM-DD format' },
        waiting: { type: 'boolean', description: 'Whether the task is waiting on someone else (default: false)' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description: 'Update an existing task. Only include fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID (required)' },
        title: { type: 'string', description: 'New task title' },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'in-progress', 'done', 'cancelled'],
          description: 'New task status'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'New task priority'
        },
        notes: { type: 'string', description: 'New notes' },
        startDate: { type: 'string', description: 'New start date ("do date") in YYYY-MM-DD format' },
        dueDate: { type: 'string', description: 'New due date (hard deadline) in YYYY-MM-DD format' },
        waiting: { type: 'boolean', description: 'Whether the task is waiting on someone else' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'search_tasks',
    description: 'Search tasks by keyword in title and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_shopping_items',
    description: 'List items on a checklist, sorted with unchecked first. Omit listId (or pass empty string) for the fixed Shopping list; otherwise pass a custom list id from list_lists.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'Custom list ID. Omit or empty string for the Shopping list.' }
      }
    }
  },
  {
    name: 'create_shopping_item',
    description: 'Add a new item to a checklist. Defaults to the fixed Shopping list unless listId is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Item name (required)' },
        listId: { type: 'string', description: 'Custom list ID. Omit or empty string for the Shopping list.' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_shopping_item',
    description: 'Update a checklist item. Can change title or checked status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item ID (required)' },
        title: { type: 'string', description: 'New item name' },
        checked: { type: 'boolean', description: 'Whether the item is checked off' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_shopping_item',
    description: 'Delete a checklist item by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_lists',
    description: 'List all custom checklists (excluding the fixed Shopping list). Each entry has { id, name, sortOrder, hidden, createdAt, updatedAt }.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_list',
    description: 'Create a new custom checklist. The returned id can be passed as listId to the shopping-item tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the list (required)' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_list_visibility',
    description: 'Hide or show a custom checklist tab without deleting its items.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The list ID' },
        hidden: { type: 'boolean', description: 'true to hide the tab, false to show it again' }
      },
      required: ['id', 'hidden']
    }
  },
  {
    name: 'delete_list',
    description: 'Delete a custom checklist and all its items. Cannot be used on the fixed Shopping list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The list ID' }
      },
      required: ['id']
    }
  }
];

function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'list_tasks': {
      const tasks = await storage.listTasks({
        status: args.status,
        priority: args.priority
      });
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }
    case 'get_task': {
      const task = await storage.getTask(args.id);
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    }
    case 'create_task': {
      if (!args.title) {
        return { content: [{ type: 'text', text: 'Title is required' }], isError: true };
      }
      console.log('MCP create_task args:', JSON.stringify(args));
      const task = await storage.createTask({
        title: args.title,
        status: args.status,
        priority: args.priority,
        notes: args.notes,
        startDate: args.startDate,
        dueDate: args.dueDate,
        waiting: args.waiting === true
      });
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    }
    case 'update_task': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'Task ID is required' }], isError: true };
      }
      console.log('MCP update_task args:', JSON.stringify(args));
      const { id, ...updates } = args;
      if (updates.waiting !== undefined) updates.waiting = updates.waiting === true;
      const task = await storage.updateTask(id, updates);
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    }
    case 'delete_task': {
      const deleted = await storage.deleteTask(args.id);
      if (!deleted) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Task ${args.id} deleted successfully` }] };
    }
    case 'search_tasks': {
      if (!args.query) {
        return { content: [{ type: 'text', text: 'Search query is required' }], isError: true };
      }
      const tasks = await storage.searchTasks(args.query);
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }
    case 'list_shopping_items': {
      const items = await storage.listShoppingItems(args.listId || '');
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
    case 'create_shopping_item': {
      if (!args.title) {
        return { content: [{ type: 'text', text: 'Title is required' }], isError: true };
      }
      const item = await storage.createShoppingItem({
        title: args.title,
        listId: args.listId || ''
      });
      return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
    }
    case 'list_lists': {
      const lists = await storage.listLists();
      return { content: [{ type: 'text', text: JSON.stringify(lists, null, 2) }] };
    }
    case 'create_list': {
      if (!args.name) {
        return { content: [{ type: 'text', text: 'Name is required' }], isError: true };
      }
      const list = await storage.createList({ name: args.name });
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
    case 'update_list_visibility': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'List ID is required' }], isError: true };
      }
      if (typeof args.hidden !== 'boolean') {
        return { content: [{ type: 'text', text: 'Hidden must be a boolean' }], isError: true };
      }
      const list = await storage.updateList(args.id, { hidden: args.hidden });
      if (!list) {
        return { content: [{ type: 'text', text: 'List not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
    case 'delete_list': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'List ID is required' }], isError: true };
      }
      const didDelete = await storage.deleteList(args.id);
      if (!didDelete) {
        return { content: [{ type: 'text', text: 'List not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: `List ${args.id} deleted successfully` }] };
    }
    case 'update_shopping_item': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'Item ID is required' }], isError: true };
      }
      const { id: itemId, ...itemUpdates } = args;
      const item = await storage.updateShoppingItem(itemId, itemUpdates);
      if (!item) {
        return { content: [{ type: 'text', text: 'Item not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] };
    }
    case 'delete_shopping_item': {
      if (!args.id) {
        return { content: [{ type: 'text', text: 'Item ID is required' }], isError: true };
      }
      const didDelete = await storage.deleteTask(args.id);
      if (!didDelete) {
        return { content: [{ type: 'text', text: 'Item not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Item ${args.id} deleted successfully` }] };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

async function handleMessage(message, context) {
  const { method, id, params } = message;

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });

    case 'notifications/initialized':
      // Notification — no response needed
      return null;

    case 'ping':
      return jsonRpcResponse(id, {});

    case 'tools/list':
      return jsonRpcResponse(id, { tools: TOOL_DEFINITIONS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleToolCall(name, args || {});
        return jsonRpcResponse(id, result);
      } catch (err) {
        context.error(`Tool call error (${name}):`, err);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// POST /api/mcp — MCP Streamable HTTP endpoint
app.http('mcp', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    try {
      const body = await request.json();

      // Handle batch requests (array of messages)
      if (Array.isArray(body)) {
        const responses = [];
        for (const message of body) {
          const response = await handleMessage(message, context);
          if (response) responses.push(response);
        }
        if (responses.length === 0) {
          return { status: 202 };
        }
        return {
          jsonBody: responses.length === 1 ? responses[0] : responses,
          headers: { 'Content-Type': 'application/json' }
        };
      }

      // Handle single message
      const response = await handleMessage(body, context);
      if (!response) {
        // Notification — no response body
        return { status: 202 };
      }

      return {
        jsonBody: response,
        headers: { 'Content-Type': 'application/json' }
      };
    } catch (err) {
      context.error('MCP endpoint error:', err);
      return {
        status: 400,
        jsonBody: jsonRpcError(null, -32700, 'Parse error'),
        headers: { 'Content-Type': 'application/json' }
      };
    }
  }
});

// GET /api/mcp — SSE endpoint for server-initiated notifications (required by spec)
app.http('mcpGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: async (request, context) => {
    const auth = validateApiKey(request);
    if (!auth.valid) return unauthorizedResponse(auth);

    // This server doesn't send server-initiated notifications,
    // so we return 405 per the spec for servers that don't support SSE
    return {
      status: 405,
      jsonBody: { error: 'Server does not support server-initiated notifications' },
      headers: { 'Content-Type': 'application/json' }
    };
  }
});

// DELETE /api/mcp — Session termination (optional)
app.http('mcpDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: async (request, context) => {
    // Stateless server — no sessions to terminate
    return {
      status: 405,
      jsonBody: { error: 'Server is stateless, no sessions to terminate' },
      headers: { 'Content-Type': 'application/json' }
    };
  }
});
