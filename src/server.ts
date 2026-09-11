import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  entityGet,
  entitySearch,
  entityUpsert,
  evidenceGet,
  statementPropose,
  statementQuery,
  statementReview,
  typeGet,
  typeList,
  typeUpsert,
  vocabulary,
} from './tools.js';
import {
  EVIDENCE_KINDS,
  EVIDENCE_RELATIONS,
  SENSITIVITIES,
  STATEMENT_STATUSES,
  errorResult,
  jsonResult,
} from './types.js';

const VERSION = '0.1.0';

/**
 * Utopia MCP Server —— 本体系统唯一真源（ADR-0001 v1.0 §2.6）
 *
 * 权限原则：Agent 默认只能 propose，不能自行 approve。
 * review 工具属于高权限，应由外层鉴权或人工调用。
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'utopia', version: VERSION });

  // ── 只读：类型 ───────────────────────────────────────────────────────────

  server.registerTool(
    'ontology_type_list',
    {
      title: '列出本体类型',
      description: '列出 Utopia 中定义的所有本体类型（可指定 parent_type_id 过滤子类型）。',
      inputSchema: { parent_type_id: z.string().optional() },
    },
    async (args) => jsonResult(await typeList(args)),
  );

  server.registerTool(
    'ontology_type_get',
    {
      title: '读取类型定义',
      description: '按 type_id 读取类型定义，含其属性与相关关系。',
      inputSchema: { type_id: z.string() },
    },
    async (args) => jsonResult(await typeGet(args)),
  );

  // ── 只读：实体 ───────────────────────────────────────────────────────────

  server.registerTool(
    'ontology_entity_search',
    {
      title: '搜索实体',
      description: '按关键词/类型/敏感度搜索实体实例。',
      inputSchema: {
        query: z.string().optional(),
        type_id: z.string().optional(),
        sensitivity: z.enum(SENSITIVITIES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => jsonResult(await entitySearch(args)),
  );

  server.registerTool(
    'ontology_entity_upsert',
    {
      title: '创建或更新实体',
      description:
        '创建实体实例，或按字段合并更新已有实体。' +
        '这是 statement_propose 的前置：事实必须挂在已存在的实体上。',
      inputSchema: {
        entity_id: z.string(),
        type_id: z.string(),
        label: z.string(),
        sensitivity: z.enum(SENSITIVITIES).optional(),
        properties: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      const r = await entityUpsert(args);
      return r.ok ? jsonResult(r) : errorResult(String((r as { error?: string }).error ?? 'upsert failed'));
    },
  );

  server.registerTool(
    'ontology_type_upsert',
    {
      title: '创建或更新本体类型（高权限）',
      description:
        '扩展元模型：创建/更新类型及其属性定义。这是「Schema 只存在于 Utopia」的写入入口，' +
        '属于强约束变更，调用方应同步更新 ADR。',
      inputSchema: {
        type_id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        parent_type_id: z.string().optional(),
        schema_json: z.record(z.unknown()).optional(),
        properties: z
          .array(
            z.object({
              property_id: z.string(),
              name: z.string(),
              value_type: z.enum(['string', 'number', 'boolean', 'date', 'ref']),
              cardinality: z.enum(['1', '0..1', '1..*', '0..*']).optional(),
              constraints: z.record(z.unknown()).optional(),
            }),
          )
          .optional(),
      },
    },
    async (args) => {
      const r = await typeUpsert(args);
      return r.ok ? jsonResult(r) : errorResult(String((r as { error?: string }).error ?? 'upsert failed'));
    },
  );

  server.registerTool(
    'ontology_entity_get',
    {
      title: '读取实体',
      description: '按 entity_id 读取实体，并返回其已审核且未取代的权威事实。',
      inputSchema: { entity_id: z.string() },
    },
    async (args) => jsonResult(await entityGet(args)),
  );

  // ── 只读：事实查询（双时态）─────────────────────────────────────────────

  server.registerTool(
    'ontology_statement_query',
    {
      title: '查询事实断言',
      description:
        '查询事实。默认只返回 approved 且未取代的权威事实。' +
        '传 as_of 查某业务时点成立什么；传 as_recorded 查某系统时点我们以为什么。',
      inputSchema: {
        subject_id: z.string().optional(),
        predicate: z.string().optional(),
        status: z.enum(STATEMENT_STATUSES).optional(),
        sensitivity: z.enum(SENSITIVITIES).optional(),
        as_of: z.string().optional(),
        as_recorded: z.string().optional(),
        include_superseded: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => jsonResult(await statementQuery(args)),
  );

  // ── 只读：证据与溯源链 ───────────────────────────────────────────────────

  server.registerTool(
    'ontology_evidence_get',
    {
      title: '读取证据与溯源链',
      description: '按 statement_id 读取支撑它的证据链，或按 evidence_id 反查它用于哪些断言。',
      inputSchema: {
        statement_id: z.string().optional(),
        evidence_id: z.string().optional(),
      },
    },
    async (args) => jsonResult(await evidenceGet(args)),
  );

  // ── 写：提交候选事实（Agent 入口）───────────────────────────────────────

  server.registerTool(
    'ontology_statement_propose',
    {
      title: '提交候选事实',
      description:
        '向 Utopia 提交一条 candidate 事实。candidate 不参与推理与对外服务，' +
        '必须经 ontology_statement_review 审批为 approved 后才生效。' +
        '可同时附带证据（evidence 数组）建立溯源链。',
      inputSchema: {
        subject_id: z.string(),
        predicate: z.string(),
        object_entity_id: z.string().optional(),
        object_literal: z.union([z.string(), z.number(), z.boolean()]).optional(),
        object_literal_type: z.enum(['string', 'number', 'boolean', 'date']).optional(),
        valid_from: z.string().optional(),
        valid_to: z.string().optional(),
        sensitivity: z.enum(SENSITIVITIES).optional(),
        proposed_by: z.string(),
        source_fingerprint: z.string().optional(),
        supersedes_id: z.string().optional(),
        evidence: z
          .array(
            z.object({
              evidence_id: z.string(),
              kind: z.enum(EVIDENCE_KINDS),
              ref: z.string(),
              excerpt: z.string().optional(),
              relation: z.enum(EVIDENCE_RELATIONS).optional(),
            }),
          )
          .optional(),
      },
    },
    async (args) => {
      const r = await statementPropose(args);
      return r.ok ? jsonResult(r) : errorResult(String((r as { error?: string }).error ?? 'propose failed'));
    },
  );

  // ── 写：审批流转（高权限）────────────────────────────────────────────────

  server.registerTool(
    'ontology_statement_review',
    {
      title: '审批事实（高权限）',
      description:
        '推进一条事实的状态。合法流转：candidate→under_review|rejected|deprecated；' +
        'under_review→approved|rejected|candidate；approved→deprecated；rejected→candidate。' +
        '只有 approved 参与推理与对外服务。每次流转都会写入审计日志。',
      inputSchema: {
        statement_id: z.string(),
        to_status: z.enum(STATEMENT_STATUSES),
        actor: z.string(),
        note: z.string().optional(),
      },
    },
    async (args) => {
      const r = await statementReview(args);
      return r.ok ? jsonResult(r) : errorResult(String((r as { error?: string }).error ?? 'review failed'));
    },
  );

  // ── 元数据 ───────────────────────────────────────────────────────────────

  server.registerTool(
    'ontology_vocabulary',
    {
      title: '读取受控词表',
      description: '返回 Utopia 使用的状态、敏感度、证据类型与关系等受控词表。',
      inputSchema: {},
    },
    async () => jsonResult(vocabulary()),
  );

  return server;
}
