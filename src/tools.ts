import { api, KB_ID, officialMcp } from './client.js';
import { EVIDENCE_KINDS, EVIDENCE_RELATIONS, SENSITIVITIES, STATEMENT_STATUSES, type Sensitivity, type StatementStatus } from './types.js';

type EntityType = { id: string; key: string; label: string; description?: string; parents?: string[]; primary_parent?: string | null; usage?: number };
type RelationType = { id: string; key: string; label: string; description?: string; kind?: string; domains?: string[]; ranges?: string[]; datatype?: string; functional?: boolean; temporal?: string; usage?: number };
type Ontology = { entity_types: EntityType[]; relation_types: RelationType[] };
export type PendingCandidate = {
  id: string;
  chunk_id?: string;
  created_at?: string;
  subject_id?: string;
  subject_name?: string;
  proposed_predicate?: string;
  object_id?: string | null;
  object_name?: string | null;
  object_value?: unknown;
  quote?: string;
};

const kb = (suffix: string) => `/api/v1/kbs/${KB_ID}${suffix}`;
const ontology = () => api<Ontology>(kb('/ontology'));
const rowsOf = (value: any): any[] => Array.isArray(value) ? value : value?.items ?? value?.entities ?? [];
const candidateWaitMs = () => Math.max(5_000, Math.min(Number(process.env.UTOPIA_CANDIDATE_WAIT_MS ?? 90_000), 120_000));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const subjectAliases = new Map<string, Set<string>>();

function exactEntityName(entity: any): string {
  return String(entity?.canonical_name ?? entity?.name ?? entity?.label ?? '');
}

export function officialLiteral(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

export function findEntityByExactLabel(value: unknown, label: string): any | undefined {
  const wanted = label.trim().toLocaleLowerCase();
  return rowsOf(value).find((entity) => exactEntityName(entity).trim().toLocaleLowerCase() === wanted);
}

export function candidateToStatement(candidate: PendingCandidate, subjectOverride?: string) {
  return {
    statement_id: candidate.id,
    id: candidate.id,
    chunk_id: candidate.chunk_id,
    subject_id: subjectOverride ?? candidate.subject_id,
    official_subject_id: candidate.subject_id,
    predicate: candidate.proposed_predicate,
    object_entity_id: candidate.object_id ?? null,
    object_literal: officialLiteral(candidate.object_value) ?? candidate.object_name ?? null,
    recorded_at: candidate.created_at,
    status: 'candidate' as const,
    quote: candidate.quote,
    source: 'official-utopia',
  };
}

export function selectNewCandidateStatements(
  value: unknown,
  beforeIds: ReadonlySet<string>,
  subjectId: string,
  objectHint?: unknown,
  subjectName?: string,
) {
  const hint = objectHint === undefined ? '' : String(objectHint).trim().toLocaleLowerCase();
  const name = subjectName?.trim().toLocaleLowerCase() ?? '';
  return rowsOf(value)
    .filter((candidate: PendingCandidate) => {
      if (beforeIds.has(candidate.id)) return false;
      return candidate.subject_id === subjectId
        || (name && String(candidate.quote ?? '').toLocaleLowerCase().includes(name));
    })
    .filter((candidate: PendingCandidate) => {
      if (!hint) return true;
      const object = String(officialLiteral(candidate.object_value) ?? candidate.object_name ?? '').trim().toLocaleLowerCase();
      const quote = String(candidate.quote ?? '').toLocaleLowerCase();
      return object === hint || quote.includes(hint);
    })
    .map((candidate: PendingCandidate) => candidateToStatement(candidate, subjectId));
}

export function selectEntityFromNewCandidates(
  value: unknown,
  beforeIds: ReadonlySet<string>,
  sourceLabel: string,
): { id: string; name?: string } | undefined {
  const label = sourceLabel.trim().toLocaleLowerCase();
  const hit = rowsOf(value).find((candidate: PendingCandidate) => {
    if (beforeIds.has(candidate.id) || !candidate.subject_id) return false;
    return String(candidate.quote ?? '').toLocaleLowerCase().includes(label);
  }) as PendingCandidate | undefined;
  return hit?.subject_id ? { id: hit.subject_id, name: hit.subject_name } : undefined;
}

async function pendingQueue(): Promise<any> {
  return api(kb('/review?queue=pending&limit=200&offset=0'));
}

async function waitForEntity(label: string, beforeIds: ReadonlySet<string>): Promise<any | undefined> {
  const deadline = Date.now() + candidateWaitMs();
  do {
    const [response, pending] = await Promise.all([
      api<any>(kb(`/entities?q=${encodeURIComponent(label)}&limit=20`)),
      pendingQueue(),
    ]);
    const found = findEntityByExactLabel(response, label)
      ?? selectEntityFromNewCandidates(pending, beforeIds, label);
    if (found) return found;
    await pause(750);
  } while (Date.now() < deadline);
  return undefined;
}

async function waitForCandidate(beforeIds: ReadonlySet<string>, subjectId: string, objectHint: unknown, subjectName: string) {
  const deadline = Date.now() + candidateWaitMs();
  do {
    const hits = selectNewCandidateStatements(await pendingQueue(), beforeIds, subjectId, objectHint, subjectName);
    if (hits.length) return hits;
    await pause(750);
  } while (Date.now() < deadline);
  return [];
}

export function officialResultJson(value: any): any {
  const text = value?.content?.find?.((item: any) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return value;
  try { return JSON.parse(text); } catch { return value; }
}

async function resolveType(ref: string, graph?: Ontology): Promise<EntityType | undefined> {
  const o = graph ?? await ontology();
  return o.entity_types.find((t) => t.id === ref || t.key === ref);
}

export async function typeList(input: { parent_type_id?: string }) {
  const o = await ontology();
  let items = o.entity_types;
  if (input.parent_type_id) {
    const parent = await resolveType(input.parent_type_id, o);
    items = parent ? items.filter((t) => t.parents?.includes(parent.id)) : [];
  }
  return { items, total: items.length, source: 'official-utopia' };
}

export async function typeGet(input: { type_id: string }) {
  const o = await ontology();
  const type = await resolveType(input.type_id, o);
  if (!type) return { found: false };
  const properties = o.relation_types.filter((r) => r.kind === 'attribute' && r.domains?.includes(type.id));
  const relations = o.relation_types.filter((r) => r.kind !== 'attribute' && (r.domains?.includes(type.id) || r.ranges?.includes(type.id)));
  return { found: true, type, properties, relations, source: 'official-utopia' };
}

export async function entitySearch(input: { query?: string; type_id?: string; sensitivity?: Sensitivity; limit?: number }) {
  const q = encodeURIComponent(input.query ?? '');
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const response = await api<any>(kb(`/entities?q=${q}&limit=${limit}`));
  let items = rowsOf(response);
  if (input.type_id) items = items.filter((e) => e.type_id === input.type_id || e.type_key === input.type_id);
  return { items, total: items.length, source: 'official-utopia', note: input.sensitivity ? '官方实体 API 不使用旧 sensitivity 枚举，已忽略该过滤项。' : undefined };
}

export async function entityGet(input: { entity_id: string }) {
  try {
    const detail = await api<any>(kb(`/entities/${encodeURIComponent(input.entity_id)}`));
    return { found: true, ...detail, source: 'official-utopia' };
  } catch (error) {
    if (String(error).includes('404')) return { found: false };
    throw error;
  }
}

export async function entityUpsert(input: { entity_id: string; type_id: string; label: string; sensitivity?: Sensitivity; properties?: Record<string, unknown> }) {
  try {
    await api(kb(`/entities/${encodeURIComponent(input.entity_id)}`), { method: 'PATCH', body: JSON.stringify({ canonical_name: input.label, type_id: input.type_id }) });
    return { ok: true, was_update: true, entity_id: input.entity_id, source: 'official-utopia' };
  } catch (error) {
    if (!String(error).includes('404')) return { ok: false, error: String(error) };
  }
  const already = findEntityByExactLabel(
    await api<any>(kb(`/entities?q=${encodeURIComponent(input.label)}&limit=20`)),
    input.label,
  );
  if (already) {
    return {
      ok: true,
      was_update: false,
      was_existing: true,
      entity_id: already.id ?? already.entity_id,
      requested_external_id: input.entity_id,
      source: 'official-utopia',
    };
  }
  const type = await resolveType(input.type_id);
  const props = input.properties && Object.keys(input.properties).length ? ` Properties: ${JSON.stringify(input.properties)}.` : '';
  const before = await pendingQueue();
  const beforeIds = new Set(rowsOf(before).map((candidate: PendingCandidate) => candidate.id));
  const result = await officialMcp('remember', { text: `${input.label} is an entity of type ${type?.label ?? input.type_id}.${props}` });
  const created = await waitForEntity(input.label, beforeIds);
  if (!created) {
    return {
      ok: false,
      recorded: true,
      requested_external_id: input.entity_id,
      result,
      error: '内容已记录，但在等待窗口内未取得 Utopia 分配的实体 UUID；不得把外部 UUID 冒充官方实体 ID。',
    };
  }
  return {
    ok: true,
    proposed: true,
    entity_id: created.id ?? created.entity_id,
    requested_external_id: input.entity_id,
    result,
    source: 'official-utopia',
    note: '内容已进入 Utopia 记忆与审核队列；返回的是抽取后由 Utopia 分配的实体 UUID。',
  };
}

export async function typeUpsert(input: { type_id: string; name: string; description?: string; parent_type_id?: string; schema_json?: Record<string, unknown>; proposed_by: string; properties?: Array<{ property_id: string; name: string; value_type: 'string'|'number'|'boolean'|'date'|'ref'; cardinality?: '1'|'0..1'|'1..*'|'0..*'; constraints?: Record<string, unknown> }> }) {
  try {
    let o = await ontology();
    const existing = await resolveType(input.type_id, o);
    const parent = input.parent_type_id ? await resolveType(input.parent_type_id, o) : undefined;
    const type = existing
      ? await api<EntityType>(kb(`/ontology/entity-types/${existing.id}`), { method: 'PATCH', body: JSON.stringify({ label: input.name, description: input.description ?? '', parents: parent ? [parent.id] : existing.parents ?? [] }) })
      : await api<EntityType>(kb('/ontology/entity-types'), { method: 'POST', body: JSON.stringify({ key: input.type_id, label: input.name, description: input.description ?? '', parents: parent ? [parent.id] : [] }) });
    o = await ontology();
    const officialType = await resolveType(type.id ?? input.type_id, o) ?? type;
    const updated: string[] = [];
    for (const p of input.properties ?? []) {
      const old = o.relation_types.find((r) => r.kind === 'attribute' && r.key === p.property_id && r.domains?.includes(officialType.id));
      const datatype = ({ string: 'text', number: 'number', boolean: 'bool', date: 'date', ref: 'text' } as const)[p.value_type];
      const payload = { label: p.name, kind: 'attribute', domains: [officialType.id], temporal: 'state', functional: p.cardinality === '1' || p.cardinality === '0..1' || !p.cardinality, inverse_functional: false, description: '', datatype, unit: '' };
      if (old) await api(kb(`/ontology/relation-types/${old.id}`), { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(kb('/ontology/relation-types'), { method: 'POST', body: JSON.stringify({ key: p.property_id, ...payload }) });
      updated.push(p.property_id);
    }
    return { ok: true, type: officialType, properties_upserted: updated, source: 'official-utopia', requires_review: false, note: '官方 Utopia 的人工/API Schema 编辑保存后立即生效，并进入审计台账。' };
  } catch (error) { return { ok: false, error: String(error) }; }
}

export async function typeReview(input: { type_id: string; to_status: StatementStatus; actor: string; note?: string }) {
  const found = await typeGet({ type_id: input.type_id });
  if (!found.found) return { ok: false, error: 'type not found' };
  return { ok: input.to_status === 'approved', type: found.type, requested_status: input.to_status, note: input.to_status === 'approved' ? '官方 Utopia 中由人工/API 创建的 Schema 已生效，无需二次状态流转。' : '官方 Utopia 不支持旧 MCP 的类型状态机；请在 Web 本体工作台修改或删除。' };
}

export async function statementQuery(input: { subject_id?: string; predicate?: string; status?: StatementStatus; sensitivity?: Sensitivity; as_of?: string; as_recorded?: string; include_superseded?: boolean; limit?: number }) {
  if (!input.subject_id) return { ok: false, error: '官方 Utopia 事实查询需要 subject_id；先调用 ontology_entity_search。' };
  if (input.as_recorded) return { ok: false, error: 'as_recorded 请改用官方 changes 工具按记录时间窗口查询。' };
  const officialIds = [input.subject_id, ...(subjectAliases.get(input.subject_id) ?? [])];
  const [factResults, pending] = await Promise.all([
    Promise.all(officialIds.map((entityId) => officialMcp('entity_facts', { entity_id: entityId, ...(input.as_of ? { at: input.as_of.slice(0, 10) } : {}) }))),
    pendingQueue(),
  ]);
  const facts = factResults.flatMap((result) => rowsOf(officialResultJson(result))).map((fact) => ({
    ...fact,
    statement_id: fact.statement_id ?? fact.fact_id ?? fact.id,
    status: fact.status ?? 'approved',
    source: 'official-utopia',
  }));
  const candidates = rowsOf(pending)
    .filter((candidate: PendingCandidate) => officialIds.includes(candidate.subject_id ?? ''))
    .map((candidate: PendingCandidate) => candidateToStatement(candidate, input.subject_id));
  let items = input.status === 'candidate' || input.status === 'under_review'
    ? candidates
    : input.status === 'approved'
      ? facts
      : [...candidates, ...facts];
  if (input.predicate) items = items.filter((item) => item.predicate === input.predicate);
  items = items.slice(0, Math.max(1, Math.min(input.limit ?? 20, 200)));
  return {
    ok: true,
    mode: input.as_of ? 'as_of' : 'history',
    items,
    total: items.length,
    source: 'official-utopia',
    note: candidates.length ? '结果包含尚未确认的 candidate；只有 approved 事实属于已发布图谱。' : undefined,
  };
}

export async function evidenceGet(input: { statement_id?: string; evidence_id?: string }) {
  if (input.evidence_id) return { ok: false, error: '官方 API 以 fact_id 查询证据，不支持旧 evidence_id 反查。' };
  if (!input.statement_id) return { ok: false, error: 'statement_id 必填' };
  return api(kb(`/facts/${encodeURIComponent(input.statement_id)}/evidence`));
}

export async function statementPropose(input: { subject_id: string; predicate: string; object_entity_id?: string; object_literal?: unknown; object_literal_type?: string; valid_from?: string; valid_to?: string; sensitivity?: Sensitivity; proposed_by: string; source_fingerprint?: string; supersedes_id?: string; evidence?: Array<{ evidence_id: string; kind: string; ref: string; excerpt?: string; relation?: string }> }) {
  if (!input.object_entity_id && input.object_literal === undefined) return { ok: false, error: 'object_entity_id 与 object_literal 至少提供一个' };
  const subject = await entityGet({ entity_id: input.subject_id });
  const subjectName = (subject as any)?.entity?.name ?? (subject as any)?.name ?? input.subject_id;
  let object = input.object_literal;
  if (input.object_entity_id) {
    const target = await entityGet({ entity_id: input.object_entity_id });
    object = (target as any)?.entity?.name ?? (target as any)?.name ?? input.object_entity_id;
  }
  const validity = input.valid_to ? ` This held until ${input.valid_to}.` : '';
  const evidence = input.evidence?.length ? ` Evidence: ${input.evidence.map((e) => `${e.kind}:${e.ref}${e.excerpt ? ` (${e.excerpt})` : ''}`).join('; ')}.` : '';
  const before = await pendingQueue();
  const beforeIds = new Set(rowsOf(before).map((candidate: PendingCandidate) => candidate.id));
  const result = await officialMcp('remember', { text: `${subjectName} ${input.predicate} ${String(object)}.${validity}${evidence}`, ...(input.valid_from ? { occurred_at: input.valid_from.slice(0, 10) } : {}) });
  const candidates = await waitForCandidate(beforeIds, input.subject_id, object, subjectName);
  if (!candidates.length) {
    return {
      ok: false,
      recorded: true,
      result,
      error: '内容已记录，但在等待窗口内未取得可寻址 candidate；不得返回无法复核或审批的成功。',
    };
  }
  for (const candidate of candidates) {
    const officialId = candidate.official_subject_id;
    if (!officialId || officialId === input.subject_id) continue;
    const aliases = subjectAliases.get(input.subject_id) ?? new Set<string>();
    aliases.add(officialId);
    subjectAliases.set(input.subject_id, aliases);
  }
  return {
    ok: true,
    status: 'proposed',
    statement_id: candidates[0].statement_id,
    subject_id: input.subject_id,
    items: candidates,
    result,
    source: 'official-utopia',
    note: '内容已进入 Utopia 审核队列并返回官方 candidate UUID；事实尚未成为已确认本体。',
  };
}

export async function statementReview(input: { statement_id: string; to_status: StatementStatus; actor: string; note?: string }) {
  if (process.env.UTOPIA_REVIEW_ENABLED !== '1') {
    return { ok: false, error: '人工审核写入默认关闭；仅服务器显式设置 UTOPIA_REVIEW_ENABLED=1 后才允许 confirm/reject。' };
  }
  try {
    if (input.to_status === 'approved') return { ok: true, result: await api(kb(`/facts/${input.statement_id}/confirm`), { method: 'POST' }) };
    if (input.to_status === 'rejected') return { ok: true, result: await api(kb(`/facts/${input.statement_id}/reject`), { method: 'POST' }) };
    return { ok: false, error: `官方 Utopia 不支持旧状态 ${input.to_status} 的直接流转；仅映射 approved→confirm、rejected→reject。` };
  } catch (error) { return { ok: false, error: String(error) }; }
}

export function vocabulary() {
  return { statement_statuses: STATEMENT_STATUSES, sensitivities: SENSITIVITIES, evidence_kinds: EVIDENCE_KINDS, evidence_relations: EVIDENCE_RELATIONS, official_fact_actions: ['confirm', 'reject'], official_mcp_tools: ['search_chunks', 'get_document', 'search_docs', 'find_entities', 'entity_facts', 'changes', 'remember'] };
}
