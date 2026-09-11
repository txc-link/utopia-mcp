import { db } from './db.js';
import {
  EVIDENCE_KINDS,
  EVIDENCE_RELATIONS,
  SENSITIVITIES,
  STATEMENT_STATUSES,
  type EvidenceKind,
  type EvidenceRelation,
  type Sensitivity,
  type StatementStatus,
} from './types.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ── 只读：类型 ─────────────────────────────────────────────────────────────

export async function typeList(input: { parent_type_id?: string }) {
  const rows = input.parent_type_id
    ? await db.query(
        `select type_id, name, description, parent_type_id, schema_json
           from ont_type where parent_type_id = $1 order by type_id`,
        [input.parent_type_id],
      )
    : await db.query(
        `select type_id, name, description, parent_type_id, schema_json
           from ont_type order by coalesce(parent_type_id,''), type_id`,
      );
  return { items: rows.rows, total: rows.rowCount };
}

export async function typeGet(input: { type_id: string }) {
  const t = await db.query(`select * from ont_type where type_id = $1`, [input.type_id]);
  if (t.rowCount === 0) return { found: false };
  const [props, rels] = await Promise.all([
    db.query(`select * from ont_property where type_id = $1 order by name`, [input.type_id]),
    db.query(
      `select * from ont_relation where from_type_id = $1 or to_type_id = $1 order by name`,
      [input.type_id],
    ),
  ]);
  return { found: true, type: t.rows[0], properties: props.rows, relations: rels.rows };
}

// ── 只读：实体 ─────────────────────────────────────────────────────────────

export async function entitySearch(input: {
  query?: string;
  type_id?: string;
  sensitivity?: Sensitivity;
  limit?: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (input.query) {
    params.push(`%${input.query}%`);
    where.push(`(label ilike $${params.length} or entity_id ilike $${params.length})`);
  }
  if (input.type_id) {
    params.push(input.type_id);
    where.push(`type_id = $${params.length}`);
  }
  if (input.sensitivity) {
    params.push(input.sensitivity);
    where.push(`sensitivity = $${params.length}`);
  }
  params.push(clamp(input.limit ?? 20, 1, 100));
  const sql = `select entity_id, type_id, label, sensitivity, created_at
                 from ont_entity
                ${where.length ? 'where ' + where.join(' and ') : ''}
                order by entity_id
                limit $${params.length}`;
  const r = await db.query(sql, params);
  return { items: r.rows, total: r.rowCount };
}

export async function entityGet(input: { entity_id: string }) {
  const e = await db.query(`select * from ont_entity where entity_id = $1`, [input.entity_id]);
  if (e.rowCount === 0) return { found: false };
  // 只返回已审核且未取代的权威事实（§2.4）
  const stmts = await db.query(
    `select statement_id, predicate, object_entity_id, object_literal,
            valid_from, valid_to, recorded_at, status, sensitivity
       from ont_statement
      where subject_id = $1 and status = 'approved' and superseded_at is null
      order by predicate, recorded_at desc`,
    [input.entity_id],
  );
  return { found: true, entity: e.rows[0], statements: stmts.rows };
}

// ── 只读：事实查询（含双时态语义）─────────────────────────────────────────

export async function statementQuery(input: {
  subject_id?: string;
  predicate?: string;
  status?: StatementStatus;
  sensitivity?: Sensitivity;
  as_of?: string;
  as_recorded?: string;
  include_superseded?: boolean;
  limit?: number;
}) {
  // as-of：某业务时点成立什么（仅 approved 且未取代）
  if (input.as_of && input.subject_id) {
    const r = await db.query(`select * from ont_as_of($1, $2::timestamptz)`, [
      input.subject_id,
      input.as_of,
    ]);
    return { mode: 'as_of', at: input.as_of, items: r.rows, total: r.rowCount };
  }

  // as-recorded：某系统时点我们以为什么
  if (input.as_recorded && input.subject_id) {
    const r = await db.query(`select * from ont_as_recorded($1, $2::timestamptz)`, [
      input.subject_id,
      input.as_recorded,
    ]);
    return { mode: 'as_recorded', at: input.as_recorded, items: r.rows, total: r.rowCount };
  }

  const params: unknown[] = [];
  const where: string[] = [];
  if (!input.include_superseded) where.push(`superseded_at is null`);
  if (input.subject_id) {
    params.push(input.subject_id);
    where.push(`subject_id = $${params.length}`);
  }
  if (input.predicate) {
    params.push(input.predicate);
    where.push(`predicate = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  } else {
    where.push(`status = 'approved'`); // 默认只看权威事实
  }
  if (input.sensitivity) {
    params.push(input.sensitivity);
    where.push(`sensitivity = $${params.length}`);
  }
  params.push(clamp(input.limit ?? 20, 1, 200));
  const r = await db.query(
    `select * from ont_statement
      where ${where.join(' and ')}
      order by recorded_at desc
      limit $${params.length}`,
    params,
  );
  return { mode: 'current', items: r.rows, total: r.rowCount };
}

// ── 只读：证据与溯源链 ─────────────────────────────────────────────────────

export async function evidenceGet(input: { statement_id?: string; evidence_id?: string }) {
  if (input.evidence_id) {
    const e = await db.query(`select * from ont_evidence where evidence_id = $1`, [input.evidence_id]);
    if (e.rowCount === 0) return { found: false };
    const links = await db.query(
      `select statement_id, relation from ont_statement_evidence where evidence_id = $1`,
      [input.evidence_id],
    );
    return { found: true, evidence: e.rows[0], used_by: links.rows };
  }
  if (!input.statement_id) return { error: 'statement_id 或 evidence_id 必须提供一个' };
  const rows = await db.query(
    `select e.*, se.relation
       from ont_statement_evidence se
       join ont_evidence e using (evidence_id)
      where se.statement_id = $1
      order by e.recorded_at`,
    [input.statement_id],
  );
  return { statement_id: input.statement_id, chain: rows.rows, total: rows.rowCount };
}

// ── 写：提交 candidate（Agent 入口，§2.6 权限原则）────────────────────────

/**
 * 创建或更新实体实例。
 *
 * 为什么需要它：`ontology_statement_propose` 只能对**已存在**的实体断言事实。
 * 若没有实体创建入口，Agent 就必须绕过 MCP 直接写库，破坏「所有写入都经过
 * 校验与审计」的边界。
 *
 * 更新采用「字段级合并」：只覆盖显式传入的字段，未传字段保持原值；
 * 实体本身不是双时态对象（事实才是），因此允许就地更新，但会记录 updated_at。
 */
export async function entityUpsert(input: {
  entity_id: string;
  type_id: string;
  label: string;
  sensitivity?: Sensitivity;
  properties?: Record<string, unknown>;
}) {
  if (!input.entity_id?.trim() || !input.type_id?.trim() || !input.label?.trim()) {
    return { ok: false, error: 'entity_id / type_id / label 均为必填' };
  }
  try {
    const r = await db.query(
      `insert into ont_entity (entity_id, type_id, label, sensitivity, properties)
       values ($1,$2,$3,$4,$5::jsonb)
       on conflict (entity_id) do update set
         type_id     = excluded.type_id,
         label       = excluded.label,
         sensitivity = excluded.sensitivity,
         properties  = ont_entity.properties || excluded.properties
       returning entity_id, type_id, label, sensitivity, properties, created_at,
                 (xmax <> 0) as was_update`,
      [
        input.entity_id.trim(),
        input.type_id.trim(),
        input.label.trim(),
        input.sensitivity ?? 'team',
        JSON.stringify(input.properties ?? {}),
      ],
    );
    return { ok: true, entity: r.rows[0] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ont_entity_type_id_fkey')) {
      return { ok: false, error: `类型不存在: ${input.type_id}（先用 ontology_type_upsert 创建）` };
    }
    return { ok: false, error: msg };
  }
}

/**
 * 创建或更新本体类型（元模型，高权限）。
 *
 * 这是「Schema 只存在于 Utopia」的写入入口。与事实不同，元模型变更不是
 * 双时态对象，但属于强约束变更，调用方应在 ADR 中留痕。
 */
export async function typeUpsert(input: {
  type_id: string;
  name: string;
  description?: string;
  parent_type_id?: string;
  schema_json?: Record<string, unknown>;
  properties?: Array<{
    property_id: string;
    name: string;
    value_type: 'string' | 'number' | 'boolean' | 'date' | 'ref';
    cardinality?: '1' | '0..1' | '1..*' | '0..*';
    constraints?: Record<string, unknown>;
  }>;
}) {
  if (!input.type_id?.trim() || !input.name?.trim()) {
    return { ok: false, error: 'type_id / name 均为必填' };
  }
  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('begin');
    const t = await client.query(
      `insert into ont_type (type_id, name, description, parent_type_id, schema_json)
       values ($1,$2,$3,$4,$5::jsonb)
       on conflict (type_id) do update set
         name           = excluded.name,
         description    = coalesce(excluded.description, ont_type.description),
         parent_type_id = excluded.parent_type_id,
         schema_json    = ont_type.schema_json || excluded.schema_json
       returning *`,
      [
        input.type_id.trim(),
        input.name.trim(),
        input.description ?? null,
        input.parent_type_id ?? null,
        JSON.stringify(input.schema_json ?? {}),
      ],
    );
    const props: string[] = [];
    for (const p of input.properties ?? []) {
      await client.query(
        `insert into ont_property (property_id, type_id, name, value_type, cardinality, constraints)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (property_id) do update set
           name        = excluded.name,
           value_type  = excluded.value_type,
           cardinality = excluded.cardinality,
           constraints = excluded.constraints`,
        [
          p.property_id,
          input.type_id.trim(),
          p.name,
          p.value_type,
          p.cardinality ?? '1',
          JSON.stringify(p.constraints ?? {}),
        ],
      );
      props.push(p.property_id);
    }
    await client.query('commit');
    return { ok: true, type: t.rows[0], properties_upserted: props };
  } catch (e) {
    await client.query('rollback');
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

export async function statementPropose(input: {
  subject_id: string;
  predicate: string;
  object_entity_id?: string;
  object_literal?: unknown;
  object_literal_type?: 'string' | 'number' | 'boolean' | 'date';
  valid_from?: string;
  valid_to?: string;
  sensitivity?: Sensitivity;
  proposed_by: string;
  source_fingerprint?: string;
  supersedes_id?: string;
  evidence?: Array<{ evidence_id: string; kind: EvidenceKind; ref: string; excerpt?: string; relation?: EvidenceRelation }>;
}) {
  if (!input.object_entity_id && input.object_literal === undefined) {
    return { ok: false, error: 'object_entity_id 与 object_literal 至少提供一个' };
  }
  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('begin');
    const ins = await client.query(
      `insert into ont_statement
         (subject_id, predicate, object_entity_id, object_literal, object_literal_type,
          valid_from, valid_to, sensitivity, proposed_by, source_fingerprint, supersedes_id)
       values ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9,$10,$11)
       returning statement_id, status, recorded_at`,
      [
        input.subject_id,
        input.predicate,
        input.object_entity_id ?? null,
        input.object_literal === undefined ? null : JSON.stringify(input.object_literal),
        input.object_literal_type ?? null,
        input.valid_from ?? null,
        input.valid_to ?? null,
        input.sensitivity ?? 'team',
        input.proposed_by,
        input.source_fingerprint ?? null,
        input.supersedes_id ?? null,
      ],
    );
    const statementId = ins.rows[0].statement_id as string;

    const linked: string[] = [];
    for (const ev of input.evidence ?? []) {
      await client.query(
        `insert into ont_evidence (evidence_id, kind, ref, excerpt)
         values ($1,$2,$3,$4)
         on conflict (evidence_id) do update set ref = excluded.ref,
                                                 excerpt = coalesce(excluded.excerpt, ont_evidence.excerpt)`,
        [ev.evidence_id, ev.kind, ev.ref, ev.excerpt ?? null],
      );
      await client.query(
        `insert into ont_statement_evidence (statement_id, evidence_id, relation)
         values ($1,$2,$3) on conflict do nothing`,
        [statementId, ev.evidence_id, ev.relation ?? 'supports'],
      );
      linked.push(ev.evidence_id);
    }
    await client.query('commit');
    return {
      ok: true,
      statement_id: statementId,
      status: 'candidate',
      recorded_at: ins.rows[0].recorded_at,
      evidence_linked: linked,
      note: 'candidate 不参与推理与对外服务；需经 ontology_statement_review 审批为 approved 后才生效',
    };
  } catch (e) {
    await client.query('rollback');
    // 幂等去重（§5.5）：唯一索引冲突给出明确提示
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('uniq_stmt_fingerprint')) {
      return { ok: false, error: 'duplicate', detail: '同一 source_fingerprint 已存在未取代的断言（幂等去重）' };
    }
    return { ok: false, error: msg };
  } finally {
    client.release();
  }
}

// ── 写：审批流转（高权限，§2.6）──────────────────────────────────────────

export async function statementReview(input: {
  statement_id: string;
  to_status: StatementStatus;
  actor: string;
  note?: string;
}) {
  if (!STATEMENT_STATUSES.includes(input.to_status)) {
    return { ok: false, error: `非法状态: ${input.to_status}` };
  }
  try {
    // 注意：不要写成 `select (ont_transition(...)).*` —— 展开复合类型时
    // PostgreSQL 可能对函数多次求值。第一次调用会改状态，第二次便读到新状态
    // 而抛出"非法流转"，最终整个语句回滚，表现为"每次都报错但库没变"。
    // 用 FROM 形式可保证函数只执行一次。
    const r = await db.query(`select * from ont_transition($1::bigint,$2,$3,$4)`, [
      input.statement_id,
      input.to_status,
      input.actor,
      input.note ?? null,
    ]);
    const log = await db.query(
      `select from_status, to_status, actor, note, at
         from ont_review_log where statement_id = $1 order by log_id desc limit 1`,
      [input.statement_id],
    );
    return { ok: true, statement: r.rows[0], audit: log.rows[0] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 元数据（供 MCP 自检）──────────────────────────────────────────────────

export function vocabulary() {
  return {
    statement_statuses: STATEMENT_STATUSES,
    sensitivities: SENSITIVITIES,
    evidence_kinds: EVIDENCE_KINDS,
    evidence_relations: EVIDENCE_RELATIONS,
  };
}
