import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompactSubmissions } from '../client/compact-submission.ts';

test('unconfirmed submissions survive remount and keep their ID only for the same input', () => {
  let count = 0;
  const submissions = createCompactSubmissions(() => `request-${++count}`);
  const input = { agentId: 'a', revision: 'rev', target: { sessionId: 'native-a', activityKey: 'activity-1' } };
  const original = submissions.prepare('host-a', input);
  assert.deepEqual(submissions.get('host-a', 'a'), original);
  assert.deepEqual(submissions.prepare('host-a', structuredClone(input)), original);
  assert.notEqual(submissions.prepare('host-b', { agentId: 'a', revision: 'rev' }).operationId, original.operationId);
  assert.notEqual(submissions.prepare('host-a', { agentId: 'b', revision: 'rev' }).operationId, original.operationId);
  submissions.acknowledge('host-a', 'a', 'foreign');
  assert.deepEqual(submissions.get('host-a', 'a'), original);
  submissions.acknowledge('host-a', 'a', original.operationId);
  assert.equal(submissions.get('host-a', 'a'), undefined);
  assert.notEqual(submissions.prepare('host-a', input).operationId, original.operationId);
});

test('changed input replaces an unconfirmed submission instead of resending the old one', () => {
  let count = 0;
  const submissions = createCompactSubmissions(() => `request-${++count}`);
  const target = { sessionId: 'native-a', activityKey: 'activity-1' };
  const original = submissions.prepare('host-a', { agentId: 'a', revision: 'rev', target });
  for (const changed of [{ revision: 'new-rev', target }, { revision: 'rev', target: { ...target, activityKey: 'activity-2' } },
    { revision: 'rev', target: { ...target, sessionId: 'native-b' } }, { revision: 'rev' }]) {
    const next = submissions.prepare('host-a', { agentId: 'a', ...changed });
    assert.notEqual(next.operationId, original.operationId);
    assert.deepEqual(submissions.get('host-a', 'a'), next);
    assert.equal(next.revision, changed.revision);
  }
  submissions.acknowledge('host-a', 'a', original.operationId);
  assert.notEqual(submissions.get('host-a', 'a'), undefined, 'the replaced ID no longer acknowledges the new one');
});
