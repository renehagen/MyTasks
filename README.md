# MyTasks

A simple task tracker with a remote MCP endpoint, deployed as an Azure Static Web App.

- CRUD API for tasks (title, status, priority, notes, due date)
- Remote MCP server (Streamable HTTP) for Claude.ai integration
- Clean, mobile-first web UI
- API key authentication
- Azure Table Storage backend

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local)
- [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) (for local dev)
- An Azure account

## Azure Setup

### 1. Create a Resource Group

```bash
az group create --name rg-mytasks --location westeurope
```

### 2. Create a Storage Account

```bash
az storage account create \
  --name stmytasks$(openssl rand -hex 4) \
  --resource-group rg-mytasks \
  --location westeurope \
  --sku Standard_LRS \
  --kind StorageV2
```

Get the connection string:

```bash
az storage account show-connection-string \
  --name <storage-account-name> \
  --resource-group rg-mytasks \
  --query connectionString -o tsv
```

### 3. Create a Static Web App

```bash
az staticwebapp create \
  --name swa-mytasks \
  --resource-group rg-mytasks \
  --location westeurope \
  --source https://github.com/renehagen/MyTasks \
  --branch main \
  --app-location /src \
  --api-location /api \
  --output-location "" \
  --login-with-github
```

### 4. Configure Environment Variables

In the Azure Portal, go to your Static Web App > Configuration > Application settings and add:

| Name | Value |
|------|-------|
| `AZURE_STORAGE_CONNECTION_STRING` | Your storage account connection string |
| `API_KEY` | A strong random string (e.g., `openssl rand -base64 32`) |

Or via CLI:

```bash
az staticwebapp appsettings set \
  --name swa-mytasks \
  --resource-group rg-mytasks \
  --setting-names \
    AZURE_STORAGE_CONNECTION_STRING="<your-connection-string>" \
    API_KEY="<your-api-key>"
```

### 5. Set GitHub Actions Secret

Get your SWA deployment token:

```bash
az staticwebapp secrets list \
  --name swa-mytasks \
  --resource-group rg-mytasks \
  --query properties.apiKey -o tsv
```

Add it as a GitHub repository secret named `AZURE_STATIC_WEB_APPS_API_TOKEN`.

## Local Development

### 1. Install API dependencies

```bash
cd api
npm install
```

### 2. Configure local settings

Edit `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AZURE_STORAGE_CONNECTION_STRING": "UseDevelopmentStorage=true",
    "API_KEY": "dev-api-key-change-me"
  }
}
```

For local storage, use [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite) or point to your Azure storage account.

### 3. Run locally with SWA CLI

```bash
npm install -g @azure/static-web-apps-cli
swa start src --api-location api
```

The app will be available at `http://localhost:4280`.

## API Reference

All endpoints require an `x-api-key` header (or `Authorization: Bearer <key>`).

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks` | List tasks. Query params: `status`, `priority`, `search` |
| `GET` | `/api/tasks/{id}` | Get a single task |
| `POST` | `/api/tasks` | Create a task |
| `PUT` | `/api/tasks/{id}` | Update a task |
| `DELETE` | `/api/tasks/{id}` | Delete a task |

### Task Object

```json
{
  "id": "uuid",
  "title": "string",
  "status": "backlog | todo | in-progress | done | cancelled",
  "priority": "low | medium | high",
  "notes": "string",
  "dueDate": "YYYY-MM-DD | null",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

## MCP Endpoint

The MCP endpoint at `/api/mcp` implements the [Model Context Protocol](https://modelcontextprotocol.io/) using Streamable HTTP transport.

### Available Tools

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks with optional status/priority filters |
| `get_task` | Get a specific task by ID |
| `create_task` | Create a new task |
| `update_task` | Update an existing task |
| `delete_task` | Delete a task |
| `search_tasks` | Search tasks by keyword |

### Connecting Claude.ai

1. Go to [Claude.ai](https://claude.ai) Settings > Connectors
2. Click "Add Connector"
3. Enter the MCP endpoint URL: `https://<your-app>.azurestaticapps.net/api/mcp`
4. Configure authentication with your API key
5. Save and start using your tasks in Claude conversations

### Testing the MCP endpoint

```bash
# Initialize
curl -X POST https://<your-app>.azurestaticapps.net/api/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# List tools
curl -X POST https://<your-app>.azurestaticapps.net/api/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST https://<your-app>.azurestaticapps.net/api/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}'
```

## Deployment

Push to `main` to trigger automatic deployment via GitHub Actions. Pull requests get preview environments.

## Project Structure

```
MyTasks/
├── src/                     # Frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── api/                     # Azure Functions API
│   ├── src/
│   │   ├── functions/
│   │   │   ├── tasks.js     # REST CRUD endpoints
│   │   │   └── mcp.js       # MCP Streamable HTTP endpoint
│   │   └── shared/
│   │       ├── auth.js      # API key validation
│   │       └── storage.js   # Azure Table Storage client
│   ├── package.json
│   ├── host.json
│   └── local.settings.json
├── staticwebapp.config.json
├── .github/workflows/
│   └── deploy.yml
└── README.md
```
