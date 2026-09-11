import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { ping } from './db.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.UTOPIA_TOKEN ?? '';

if (!process.env.UTOPIA_DB_URL) {
  console.error('utopia-mcp: UTOPIA_DB_URL is not set');
  process.exit(1);
}
if (!TOKEN) {
  console.error('utopia-mcp: UTOPIA_TOKEN is not set（拒绝以无鉴权方式启动）');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

/** 健康检查：不鉴权，供容器/网关探活。 */
app.get('/health', async (_req: Request, res: Response) => {
  const db = await ping();
  res.status(db.ok ? 200 : 503).json({ status: db.ok ? 'ok' : 'degraded', db });
});

/** 鉴权：除 /health 外一律要求 Bearer。 */
app.use((req: Request, res: Response, next) => {
  const auth = req.header('authorization') ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }
  next();
});

/**
 * MCP Streamable HTTP 端点（有状态会话）。
 *
 * 注意：不要用无状态模式（sessionIdGenerator: undefined + 每请求新建 server）。
 * 客户端（如 Codex）会在 initialize 之后复用同一个会话做 tools/list 与 tools/call；
 * 无状态模式下每个请求都落到新实例，客户端后续调用会报 "unsupported call"。
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport as StreamableHTTPServerTransport);
      },
    });
    transport.onclose = () => {
      const sid = transport?.sessionId;
      if (sid) transports.delete(sid);
    };
    await createServer().connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('utopia-mcp: handleRequest failed', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

/** 会话终止（客户端主动关闭）。 */
app.delete('/mcp', async (req: Request, res: Response) => {
  const sid = req.header('mcp-session-id');
  const transport = sid ? transports.get(sid) : undefined;
  if (transport) {
    await transport.close();
    if (sid) transports.delete(sid);
  }
  res.status(204).end();
});

/** SSE 流（服务端主动推送到已有会话）。 */
app.get('/mcp', async (req: Request, res: Response) => {
  const sid = req.header('mcp-session-id');
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    res.status(400).type('text/plain').send('Invalid or missing session');
    return;
  }
  await transport.handleRequest(req, res);
});

const httpServer = app.listen(PORT, () => {
  console.log(`utopia-mcp ${PORT} listening (auth required, db-backed)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    httpServer.close(() => process.exit(0));
  });
}
