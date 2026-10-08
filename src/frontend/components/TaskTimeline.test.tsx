import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  applyWorkflowCommand,
  createWorkflow,
} from '../../workflow/workflow';
import { TaskTimeline } from './TaskTimeline';

describe('TaskTimeline', () => {
  it('derives current state and visible history from the saved aggregate', () => {
    const initial = createWorkflow({
      task: { id: 'task-1', tenantId: 'workspace-1', ownerId: 'user-1' },
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'create',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });
    const aggregate = applyWorkflowCommand(initial, {
      taskId: 'task-1',
      tenantId: 'workspace-1',
      ownerId: 'user-1',
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'start',
      expectedSequence: 1,
      occurredAt: '2026-10-08T10:01:00.000Z',
      type: 'start',
    });

    render(<TaskTimeline aggregate={aggregate} />);

    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Running');
    expect(screen.getByRole('listitem', { name: 'Planning, Visited' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Verifying, Upcoming' })).toBeInTheDocument();
    expect(screen.getByText('Task created in Planning')).toBeInTheDocument();
    expect(screen.getByText('Planning → Running')).toBeInTheDocument();
  });

  it('renders persisted verification evidence in the event timeline', () => {
    let aggregate = createWorkflow({
      task: { id: 'task-2', tenantId: 'workspace-1', ownerId: 'user-1' },
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'create-2',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });
    aggregate = applyWorkflowCommand(aggregate, {
      taskId: 'task-2',
      tenantId: 'workspace-1',
      ownerId: 'user-1',
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'start-2',
      expectedSequence: 1,
      occurredAt: '2026-10-08T10:01:00.000Z',
      type: 'start',
    });
    aggregate = applyWorkflowCommand(aggregate, {
      taskId: 'task-2',
      tenantId: 'workspace-1',
      ownerId: 'user-1',
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'verify-2',
      expectedSequence: 2,
      occurredAt: '2026-10-08T10:02:00.000Z',
      type: 'begin-verification',
    });
    aggregate = applyWorkflowCommand(aggregate, {
      taskId: 'task-2',
      tenantId: 'workspace-1',
      ownerId: 'user-1',
      actorId: 'user-1',
      actorTenantId: 'workspace-1',
      idempotencyKey: 'record-2',
      expectedSequence: 3,
      occurredAt: '2026-10-08T10:03:00.000Z',
      type: 'record-verification',
      result: {
        passed: true,
        evidenceReference: 'receipt://test/check-1',
        verifiedBy: 'user-1',
        verifiedAt: '2026-10-08T10:03:00.000Z',
      },
    });

    render(<TaskTimeline aggregate={aggregate} />);

    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Completed');
    expect(screen.getByText('Verification passed — evidence: receipt://test/check-1')).toBeInTheDocument();
  });
});
