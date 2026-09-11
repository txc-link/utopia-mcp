import pg from 'pg';

const { Pool } = pg;

/**
 * Utopia 唯一真源的数据库连接。
 * 连接串只来自环境变量，不落任何文件（容器由 compose 注入）。
 */
export const pool = new Pool({
  connectionString: process.env.UTOPIA_DB_URL,
  max: Number(process.env.UTOPIA_DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export type Queryable = {
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
};

export const db: Queryable = {
  query: (text, values) => pool.query(text, values),
};

export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await pool.query<{ version: string }>('select version()');
    return { ok: true, version: r.rows[0]?.version?.split(',')[0] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
