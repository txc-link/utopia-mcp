/** 与 001_schema.sql 中的 CHECK 约束保持一致。 */

export const STATEMENT_STATUSES = [
  'candidate',
  'under_review',
  'approved',
  'rejected',
  'deprecated',
] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const SENSITIVITIES = ['public', 'team', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const EVIDENCE_KINDS = ['conversation', 'document', 'commit', 'url', 'manual'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_RELATIONS = ['supports', 'refutes', 'context'] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

export interface OntType {
  type_id: string;
  name: string;
  description: string | null;
  parent_type_id: string | null;
  schema_json: Record<string, unknown>;
  created_at: string;
}

export interface OntEntity {
  entity_id: string;
  type_id: string;
  label: string;
  sensitivity: Sensitivity;
  properties: Record<string, unknown>;
  created_at: string;
}

export interface OntStatement {
  statement_id: string;
  subject_id: string;
  predicate: string;
  object_entity_id: string | null;
  object_literal: unknown;
  object_literal_type: string | null;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  superseded_at: string | null;
  status: StatementStatus;
  sensitivity: Sensitivity;
  proposed_by: string | null;
  proposed_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  supersedes_id: string | null;
  source_fingerprint: string | null;
}

export interface OntEvidence {
  evidence_id: string;
  kind: EvidenceKind;
  ref: string;
  excerpt: string | null;
  weight: string;
  recorded_at: string;
  metadata: Record<string, unknown>;
}

/** 工具统一返回 MCP content 结构。 */
export function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}
