import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { assertOfficialConfig, health } from './client.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.UTOPIA_TOKEN ?? '';

try { assertOfficialConfig(); } catch (error) { console.error(String(error)); process.exit(1); }
if (!TOKEN) {
  console.error('utopia-mcp: UTOPIA_TOKEN is not set（拒绝以无鉴权方式启动）');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '4mb' }));

/** 健康检查：不鉴权，供容器/网关探活。 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const upstream = await health();
    res.status(200).json({ status: 'ok', backend: 'official-utopia', upstream });
  } catch (error) {
    res.status(503).json({ status: 'degraded', backend: 'official-utopia', error: String(error) });
  }
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

/**
 * 会话失效（服务端重启、会话被回收）时的标准应答。
 *
 * 规范要求未知/过期 session 返回 **404**，客户端据此重新 initialize。
 * 反例（不要这么写）：直接放行到一个未初始化的新 transport —— SDK 会抛
 * `Bad Request: Server not initialized`，且响应体里 `id: null` 无法与请求关联，
 * 实测 codex-mcp-client 会一直等到超时（默认 300s）而不是报错。
 */
function sessionNotFound(res: Response): void {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.header('mcp-session-id');

  // 已有会话：复用。未知会话必须 404，让客户端重新握手。
  if (sessionId) {
    const existing = transports.get(sessionId);
    if (!existing) {
      console.warn(`utopia-mcp: unknown session ${sessionId} → 404（客户端应重新 initialize）`);
      sessionNotFound(res);
      return;
    }
    await existing.handleRequest(req, res, req.body);
    return;
  }

  // 无会话：只有 initialize 能开新会话，其余请求快速失败（错误里带上请求 id，便于客户端关联）。
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad Request: missing Mcp-Session-Id (initialize first)' },
      id: (req.body as { id?: unknown })?.id ?? null,
    });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
    },
  });
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) transports.delete(sid);
  };
  await createServer().connect(transport);

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
    sessionNotFound(res);
    return;
  }
  await transport.handleRequest(req, res);
});

const httpServer = app.listen(PORT, () => {
  console.log(`utopia-mcp-adapter ${PORT} listening (auth required, official-api-backed)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    httpServer.close(() => process.exit(0));
  });
}
