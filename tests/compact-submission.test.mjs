import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompactSubmissions } from '../client/compact-submission.ts';

test('unconfirmed submissions survive remount and reuse the original input on retries', () => {
  let count = 0;
  const submissions = createCompactSubmissions(() => `request-${++count}`);
  const original = submissions.prepare('host-a', { agentId: 'a', revision: 'rev',
    target: { sessionId: 'native-a', activityKey: 'activity-1' } });
  assert.deepEqual(submissions.get('host-a', 'a'), original);
  assert.deepEqual(submissions.prepare('host-a', { agentId: 'a', revision: 'new-rev' }), original);
  assert.notEqual(submissions.prepare('host-b', { agentId: 'a', revision: 'rev' }).operationId, original.operationId);
  assert.notEqual(submissions.prepare('host-a', { agentId: 'b', revision: 'rev' }).operationId, original.operationId);
  submissions.acknowledge('host-a', 'a', 'foreign');
  assert.deepEqual(submissions.get('host-a', 'a'), original);
  submissions.acknowledge('host-a', 'a', original.operationId);
  assert.equal(submissions.get('host-a', 'a'), undefined);
  assert.notEqual(submissions.prepare('host-a', { agentId: 'a', revision: 'new-rev' }).operationId, original.operationId);
});
