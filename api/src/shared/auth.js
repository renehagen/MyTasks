const API_KEY = process.env.API_KEY;

function validateApiKey(request) {
  if (!API_KEY) {
    return { valid: false, status: 500, message: 'API_KEY not configured on server' };
  }

  const authHeader = request.headers.get('authorization');
  const apiKeyHeader = request.headers.get('x-api-key');

  let providedKey = null;
  if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7);
  }

  if (!providedKey || providedKey !== API_KEY) {
    return { valid: false, status: 401, message: 'Invalid or missing API key' };
  }

  return { valid: true };
}

function unauthorizedResponse(result) {
  return {
    status: result.status,
    jsonBody: { error: result.message },
    headers: { 'Content-Type': 'application/json' }
  };
}

module.exports = { validateApiKey, unauthorizedResponse };
