#!/usr/bin/env node
// Stdio-to-HTTP bridge for MyTasks MCP server

const API_URL = 'https://gray-flower-0b244b703.2.azurestaticapps.net/api/mcp';
const API_KEY = process.env.MYTASKS_API_KEY;

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line) handleMessage(line);
  }
});

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(msg)
    });

    if (res.status === 202) return;

    const json = await res.json();
    process.stdout.write(JSON.stringify(json) + '\n');
  } catch (err) {
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: `HTTP bridge error: ${err.message}` }
      }) + '\n');
    }
  }
}
