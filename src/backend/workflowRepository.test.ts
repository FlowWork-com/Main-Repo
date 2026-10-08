import { describe, expect, it } from 'vitest';
import {
  createWorkflow,
  type WorkflowEvent,
} from '../workflow/workflow';
import { mapEventRow, serializeEvent } from './workflowRepository';

const task = {
  id: '6f16d779-d73f-4d7e-a266-8d74ba3f0a44',
  workspace_id: '83c78654-13f8-4f7e-9a7f-66aef5ff0d80',
  owner_id: 'b2a828ae-741c-4e24-9dc1-545274c0920f',
  title: 'Review quarterly report',
  details: '',
  status: 'Planning',
  attempt: 1,
  created_at: '2026-10-08T10:00:00.000Z',
  updated_at: '2026-10-08T10:00:00.000Z',
};

function createEvent(): WorkflowEvent {
  return createWorkflow({
    task: {
      id: task.id,
      tenantId: task.workspace_id,
      ownerId: task.owner_id,
    },
    actorId: task.owner_id,
    actorTenantId: task.workspace_id,
    idempotencyKey: 'create-task',
    occurredAt: task.created_at,
  }).events[0];
}

describe('workflow persistence mapping', () => {
  it('serializes domain events into atomic RPC event payloads', () => {
    expect(serializeEvent(createEvent())).toEqual({
      sequence: 1,
      eventType: 'task.created',
      actorId: task.owner_id,
      occurredAt: task.created_at,
      idempotencyKey: 'create-task',
      requestFingerprint: expect.any(String),
      statusAfter: 'Planning',
      attempt: 1,
      payload: {},
    });
  });

  it('rebuilds the domain event using persisted task ownership context', () => {
    const event = createEvent();
    const mapped = mapEventRow({
      task_id: task.id,
      sequence: event.sequence,
      event_type: event.type,
      actor_id: event.actorId,
      occurred_at: event.occurredAt,
      idempotency_key: event.idempotencyKey,
      request_fingerprint: event.requestFingerprint,
      status_after: event.statusAfter,
      attempt: event.attempt,
      payload: {},
    }, task);

    expect(mapped).toEqual(event);
  });

  it('rejects unknown statuses and incomplete verification evidence', () => {
    expect(() =>
      mapEventRow({
        task_id: task.id,
        sequence: 1,
        event_type: 'task.created',
        actor_id: task.owner_id,
        occurred_at: task.created_at,
        idempotency_key: 'create-task',
        request_fingerprint: 'fingerprint',
        status_after: 'nonsense',
        attempt: 1,
        payload: {},
      }, task),
    ).toThrow('unsupported workflow status');

    expect(() =>
      mapEventRow({
        task_id: task.id,
        sequence: 2,
        event_type: 'verification.recorded',
        actor_id: task.owner_id,
        occurred_at: task.updated_at,
        idempotency_key: 'verify-task',
        request_fingerprint: 'fingerprint',
        status_after: 'Verifying',
        attempt: 1,
        payload: {
          result: {
            passed: true,
            evidenceReference: '',
            verifiedBy: task.owner_id,
            verifiedAt: task.updated_at,
          },
        },
      }, task),
    ).toThrow('incomplete event data');
  });
});
