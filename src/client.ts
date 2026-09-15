const BASE_URL = (process.env.UTOPIA_API_BASE ?? '').replace(/\/$/, '');
export const KB_ID = process.env.UTOPIA_KB_ID ?? '';
const EMAIL = process.env.UTOPIA_API_EMAIL ?? '';
const PASSWORD = process.env.UTOPIA_API_PASSWORD ?? '';
const PAT = process.env.UTOPIA_PAT ?? '';

let jwt = '';
let jwtExpiresAt = 0;

export function assertOfficialConfig(): void {
  const missing = [
    ['UTOPIA_API_BASE', BASE_URL], ['UTOPIA_KB_ID', KB_ID],
    ['UTOPIA_API_EMAIL', EMAIL], ['UTOPIA_API_PASSWORD', PASSWORD], ['UTOPIA_PAT', PAT],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing required environment: ${missing.join(', ')}`);
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const detail = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error) : String(body || res.statusText);
    throw new Error(`Utopia API ${res.status}: ${detail}`);
  }
  return body;
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await parseResponse(res) as { token?: string };
  if (!body.token) throw new Error('Utopia login returned no token');
  jwt = body.token;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    jwtExpiresAt = (payload.exp ?? 0) * 1000;
  } catch { jwtExpiresAt = Date.now() + 5 * 60_000; }
  return jwt;
}

async function bearer(): Promise<string> {
  if (!jwt || Date.now() > jwtExpiresAt - 60_000) return login();
  return jwt;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const request = async () => fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await bearer()}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  let res = await request();
  if (res.status === 401) { jwt = ''; res = await request(); }
  return await parseResponse(res) as T;
}

export async function health(): Promise<unknown> {
  return parseResponse(await fetch(`${BASE_URL}/api/v1/health`));
}

export async function officialMcp(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/v1/kbs/${KB_ID}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await parseResponse(res) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'Official Utopia MCP call failed');
  return body.result;
}
