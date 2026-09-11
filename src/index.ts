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
 * MCP Streamable HTTP 端点。
 * 采用无状态模式（每次请求新建 server+transport），便于水平扩展与重启。
 */
app.post('/mcp', async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
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

const httpServer = app.listen(PORT, () => {
  console.log(`utopia-mcp ${PORT} listening (auth required, db-backed)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    httpServer.close(() => process.exit(0));
  });
}
