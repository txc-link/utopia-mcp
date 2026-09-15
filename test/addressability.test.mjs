import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateToStatement,
  findEntityByExactLabel,
  officialResultJson,
  officialLiteral,
  selectNewCandidateStatements,
  selectEntityFromNewCandidates,
} from '../dist/tools.js';

test('entity lookup accepts only an exact normalized label', () => {
  const rows = {
    items: [
      { id: 'near', canonical_name: 'Probe suffix' },
      { id: 'exact', canonical_name: '  PrObE  ' },
    ],
  };
  assert.equal(findEntityByExactLabel(rows, 'probe')?.id, 'exact');
  assert.equal(findEntityByExactLabel(rows, 'prob'), undefined);
});

test('pending candidate maps to the compatibility statement shape', () => {
  assert.deepEqual(candidateToStatement({
    id: 'candidate-1',
    chunk_id: 'chunk-1',
    subject_id: 'subject-1',
    proposed_predicate: 'knows',
    object_name: 'Ada',
    created_at: '2026-09-15T09:12:30Z',
  }), {
    statement_id: 'candidate-1',
    id: 'candidate-1',
    chunk_id: 'chunk-1',
    subject_id: 'subject-1',
    official_subject_id: 'subject-1',
    predicate: 'knows',
    object_entity_id: null,
    object_literal: 'Ada',
    recorded_at: '2026-09-15T09:12:30Z',
    status: 'candidate',
    quote: undefined,
    source: 'official-utopia',
  });
});

test('official typed literal unwraps before matching and readback', () => {
  assert.equal(officialLiteral({ value: 'probe', datatype: 'text' }), 'probe');
  const [hit] = selectNewCandidateStatements({ items: [{
    id: 'typed', subject_id: 'subject-1', object_value: { value: 'probe' },
  }] }, new Set(), 'subject-1', 'probe');
  assert.equal(hit.object_literal, 'probe');
});

test('candidate correlation rejects old, wrong-subject and wrong-object rows', () => {
  const queue = { items: [
    { id: 'old', subject_id: 'subject-1', object_name: 'probe' },
    { id: 'wrong-subject', subject_id: 'subject-2', object_name: 'probe' },
    { id: 'wrong-object', subject_id: 'subject-1', object_name: 'other' },
    { id: 'hit', subject_id: 'subject-1', object_name: 'probe' },
  ] };
  const hits = selectNewCandidateStatements(queue, new Set(['old']), 'subject-1', 'probe');
  assert.deepEqual(hits.map((item) => item.statement_id), ['hit']);
});

test('candidate correlation follows the quoted subject name across normalization', () => {
  const queue = { items: [{
    id: 'hit',
    subject_id: 'new-official-subject',
    object_name: 'probe',
    quote: 'Original Subject 123 produced probe.',
  }] };
  const [hit] = selectNewCandidateStatements(
    queue, new Set(), 'requested-subject', 'probe', 'Original Subject 123',
  );
  assert.equal(hit.subject_id, 'requested-subject');
  assert.equal(hit.official_subject_id, 'new-official-subject');
});

test('entity correlation survives model-normalized names by using the new quote', () => {
  const queue = { items: [
    { id: 'old', subject_id: 'old-subject', quote: 'E4-CONTRACT-PROBE abc123 is an entity' },
    {
      id: 'new',
      subject_id: 'official-subject',
      subject_name: 'E4-CONTRACT-PROBE',
      quote: 'E4-CONTRACT-PROBE abc123 is an entity of type Person.',
    },
  ] };
  assert.deepEqual(
    selectEntityFromNewCandidates(queue, new Set(['old']), 'E4-CONTRACT-PROBE abc123'),
    { id: 'official-subject', name: 'E4-CONTRACT-PROBE' },
  );
});

test('official MCP text result unwraps JSON without inventing data', () => {
  assert.deepEqual(officialResultJson({ content: [{ type: 'text', text: '{"items":[{"id":"f1"}]}' }] }), {
    items: [{ id: 'f1' }],
  });
  const raw = { content: [{ type: 'text', text: 'not json' }] };
  assert.equal(officialResultJson(raw), raw);
});
