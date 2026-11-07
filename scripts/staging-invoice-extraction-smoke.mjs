#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const EXPECTED_STAGING_PROJECT_REF = 'flfwtsxuvzyuotltfrbt';
const FORBIDDEN_PROJECT_REFS = new Set([
  'nhvmeahmwywhaxtnuehr',
  'tlhznghnfdwpilhfjyyu',
]);
const EXPECTED = {
  invoiceNumber: 'SYNTH-INV-0001',
  invoiceDate: '2026-11-01',
  vendor: 'Synthetic Supply Co',
  description: 'Office stationery',
  currency: 'INR',
  subtotal: 1000,
  taxAmount: 180,
  totalAmount: 1180,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Required staging configuration is missing: ' + name);
  }
  return value.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  process.stdout.write(message + '\n');
}

function pdfEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function createSyntheticInvoicePdf() {
  const lines = [
    'INVOICE',
    'Invoice Number: ' + EXPECTED.invoiceNumber,
    'Invoice Date: ' + EXPECTED.invoiceDate,
    'Vendor: ' + EXPECTED.vendor,
    'Description: ' + EXPECTED.description,
    'Currency: ' + EXPECTED.currency,
    'Subtotal: 1000.00',
    'Tax Amount (GST): 180.00',
    'Grand Total: 1180.00',
  ];
  const commands = ['BT', '/F1 12 Tf', '50 750 Td'];
  for (const line of lines) {
    commands.push('(' + pdfEscape(line) + ') Tj');
    commands.push('0 -24 Td');
  }
  commands.push('ET');
  const stream = commands.join('\n') + '\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += (index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n';
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += String(offsets[index]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  return Buffer.from(pdf, 'ascii');
}

function workflowEvent(sequence, eventType, actorId, statusAfter, payload) {
  const idempotencyKey = randomUUID();
  return {
    sequence,
    eventType,
    actorId,
    occurredAt: new Date().toISOString(),
    idempotencyKey,
    requestFingerprint: 'staging-invoice-acceptance:' + idempotencyKey,
    statusAfter,
    attempt: 1,
    payload,
  };
}

async function main() {
  const rawUrl = requiredEnv('STAGING_SUPABASE_URL');
  const projectRef = requiredEnv('STAGING_SUPABASE_PROJECT_REF');
  const anonKey = requiredEnv('STAGING_SUPABASE_ANON_KEY');
  const workspaceId = requiredEnv('STAGING_WORKSPACE_ID');
  const requesterId = requiredEnv('STAGING_TEST_USER_ID');

  const parsedUrl = new URL(rawUrl);
  assert(/^[a-z0-9]{20}$/.test(projectRef), 'Staging project reference is invalid.');
  assert(projectRef === EXPECTED_STAGING_PROJECT_REF,
    'Refusing to run outside the confirmed FlowWork Staging project.');
  assert(!FORBIDDEN_PROJECT_REFS.has(projectRef),
    'Refusing to run against FlowWork Main DB production or the separate Invoice DB.');
  assert(
    parsedUrl.protocol === 'https:' &&
      parsedUrl.hostname === projectRef + '.supabase.co' &&
      parsedUrl.pathname === '/' &&
      !parsedUrl.search &&
      !parsedUrl.hash,
    'Staging URL does not match the dedicated staging project reference.',
  );
  assert(UUID.test(workspaceId) && UUID.test(requesterId),
    'Workspace and requester inputs must be UUIDs.');

  const client = createClient(parsedUrl.origin, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  try {
    const signedIn = await client.auth.signInWithPassword({
      email: requiredEnv('STAGING_TEST_USER_EMAIL'),
      password: requiredEnv('STAGING_TEST_USER_PASSWORD'),
    });
    assert(
      !signedIn.error &&
        signedIn.data?.user?.id === requesterId &&
        typeof signedIn.data?.session?.access_token === 'string',
      'Requester sign-in failed or returned an unexpected user identity.',
    );
    const verified = await client.auth.getUser();
    assert(!verified.error && verified.data?.user?.id === requesterId,
      'Requester identity could not be verified.');

    const membership = await client
      .from('workspace_members')
      .select('workspace_id, user_id, role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', requesterId)
      .maybeSingle();
    assert(
      !membership.error && membership.data?.workspace_id === workspaceId &&
        membership.data?.user_id === requesterId,
      'Requester is not a member of the configured staging workspace.',
    );
    log('PASS requester identity and workspace membership verified.');

    const taskId = randomUUID();
    const initialEvent = {
      sequence: 1,
      eventType: 'task.created',
      actorId: requesterId,
      occurredAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      requestFingerprint: 'staging-invoice-acceptance:create:' + randomUUID(),
      statusAfter: 'Planning',
      attempt: 1,
      payload: {},
    };
    const created = await client.rpc('create_workflow_task', {
      p_task_id: taskId,
      p_workspace_id: workspaceId,
      p_title: 'STAGING E2E: synthetic invoice extraction acceptance',
      p_details: 'Synthetic invoice only. No customer, supplier, or real financial data is attached.',
      p_initial_event: initialEvent,
    });
    assert(!created.error && created.data === taskId,
      'Could not create the synthetic staging workflow task.');

    const fileName = 'synthetic-invoice.pdf';
    const storagePath = workspaceId + '/' + taskId + '/' + randomUUID() + '/' + fileName;
    const uploaded = await client.storage
      .from('workflow-files')
      .upload(storagePath, createSyntheticInvoicePdf(), {
        contentType: 'application/pdf',
        upsert: false,
      });
    assert(!uploaded.error, 'Could not upload the synthetic PDF to private staging storage.');

    const registered = await client.rpc('register_task_file', {
      p_workspace_id: workspaceId,
      p_task_id: taskId,
      p_file_name: fileName,
      p_storage_path: storagePath,
      p_content_type: 'application/pdf',
    });
    assert(!registered.error && typeof registered.data === 'string',
      'Could not register the private synthetic invoice attachment.');
    const fileId = registered.data;

    const approvalRequestId = randomUUID();
    const events = [
      workflowEvent(2, 'status.changed', requesterId, 'Running', {
        from: 'Planning',
        to: 'Running',
      }),
      workflowEvent(3, 'status.changed', requesterId, 'Waiting for approval', {
        from: 'Running',
        to: 'Waiting for approval',
      }),
      workflowEvent(4, 'approval.requested', requesterId, 'Waiting for approval', {
        requestId: approvalRequestId,
      }),
    ];
    const persisted = await client.rpc('persist_workflow_events', {
      p_task_id: taskId,
      p_expected_sequence: 1,
      p_status: 'Waiting for approval',
      p_attempt: 1,
      p_events: events,
    });
    assert(!persisted.error, 'Could not persist the pending approval request.');

    const savedApproval = await client
      .from('task_approvals')
      .select('request_id, decision, requested_by, approver_id')
      .eq('task_id', taskId)
      .eq('request_id', approvalRequestId)
      .maybeSingle();
    assert(
      !savedApproval.error &&
        savedApproval.data?.request_id === approvalRequestId &&
        savedApproval.data?.decision === null &&
        savedApproval.data?.requested_by === requesterId &&
        savedApproval.data?.approver_id === null,
      'The pending approval record could not be independently verified.',
    );
    const savedTask = await client
      .from('tasks')
      .select('status')
      .eq('id', taskId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    assert(!savedTask.error && savedTask.data?.status === 'Waiting for approval',
      'The synthetic task did not remain pending independent approval.');

    log('PASS synthetic PDF is uploaded and registered in private staging storage.');
    log('PASS persisted approval request is pending; no approval has been granted and no provider was called.');
    log('Task ID: ' + taskId);
    log('Attachment file ID: ' + fileId);
    log('Approval request ID: ' + approvalRequestId);
    log('Next: a different workspace member must approve this task in the FlowWork UI.');
    log('Then the requester can select PDF/image invoice extraction and run it with input {"fileId":"' + fileId + '"}.');
    log('The extraction call itself is intentionally a separate, user-initiated action after real approval.');
    log('Synthetic task and attachment are retained in staging for audit.');
  } finally {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown staging invoice preparation failure.';
  process.stderr.write('FAIL ' + message + '\n');
  process.exitCode = 1;
}
