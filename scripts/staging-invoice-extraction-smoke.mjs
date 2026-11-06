#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

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

function makeClient(url, anonKey) {
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

async function signIn(client, email, password, expectedUserId, label) {
  const result = await client.auth.signInWithPassword({ email, password });
  assert(
    !result.error &&
      result.data?.user?.id === expectedUserId &&
      typeof result.data?.session?.access_token === 'string',
    label + ' sign-in failed or returned an unexpected user identity.',
  );
  const verified = await client.auth.getUser();
  assert(
    !verified.error && verified.data?.user?.id === expectedUserId,
    label + ' identity could not be verified.',
  );
  return { id: expectedUserId, accessToken: result.data.session.access_token };
}

async function assertWorkspaceMember(client, workspaceId, userId, label) {
  const result = await client
    .from('workspace_members')
    .select('workspace_id, user_id, role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  assert(
    !result.error && result.data?.workspace_id === workspaceId &&
      result.data?.user_id === userId,
    label + ' is not a member of the configured staging workspace.',
  );
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

async function persistEvents(client, taskId, expectedSequence, status, events) {
  const result = await client.rpc('persist_workflow_events', {
    p_task_id: taskId,
    p_expected_sequence: expectedSequence,
    p_status: status,
    p_attempt: 1,
    p_events: events,
  });
  assert(!result.error, 'The persisted workflow approval transition was rejected.');
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

async function postExecution(baseUrl, anonKey, accessToken, payload) {
  const response = await fetch(baseUrl + '/functions/v1/execute-tool', {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: 'Bearer ' + accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  let body = null;
  try {
    const text = await response.text();
    if (text.length <= 100_000) body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function executionErrorCode(body) {
  if (isRecord(body?.result?.error) && typeof body.result.error.code === 'string') {
    return body.result.error.code;
  }
  if (isRecord(body?.error) && typeof body.error.code === 'string') {
    return body.error.code;
  }
  return 'UNKNOWN';
}

function matchesExpected(key, actual) {
  const expected = EXPECTED[key];
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Number.isFinite(actual) &&
      Math.abs(actual - expected) <= 0.01;
  }
  if (typeof actual !== 'string') return false;
  const normalized = actual.trim().toLowerCase();
  const target = expected.toLowerCase();
  return key === 'description' ? normalized.includes(target) : normalized === target;
}

function validateReport(output) {
  assert(isRecord(output), 'Invoice extraction returned no structured report.');
  assert(output.reviewRequired === true,
    'Invoice extraction did not preserve the human-review requirement.');
  assert(output.validationStatus === 'needs_review',
    'The synthetic invoice did not produce the expected review status.');
  assert(isRecord(output.fields), 'Invoice extraction returned an invalid field map.');

  let matches = 0;
  for (const key of Object.keys(EXPECTED)) {
    const field = output.fields[key];
    assert(
      isRecord(field) &&
        (typeof field.value === 'string' || typeof field.value === 'number' || field.value === null) &&
        typeof field.confidenceEstimate === 'number' &&
        Number.isFinite(field.confidenceEstimate) &&
        field.confidenceEstimate >= 0 &&
        field.confidenceEstimate <= 1 &&
        typeof field.needsReview === 'boolean',
      'Invoice extraction returned an invalid field contract.',
    );
    if (matchesExpected(key, field.value)) matches += 1;
    if ((field.value === null || field.confidenceEstimate < 0.8) && !field.needsReview) {
      throw new Error('A missing or low-confidence field was not marked for human review.');
    }
  }

  const critical = ['invoiceNumber', 'invoiceDate', 'vendor', 'currency', 'totalAmount'];
  assert(
    critical.every((key) => matchesExpected(key, output.fields[key].value)),
    'One or more critical synthetic invoice fields did not match the fixture.',
  );
  assert(matches >= 7, 'Fewer than 7 of 8 synthetic invoice fields matched the fixture.');
  assert(
    Array.isArray(output.warnings) && Array.isArray(output.interpretationNotes),
    'Invoice extraction omitted its review warnings or limitations.',
  );
  return matches;
}

async function main() {
  const rawUrl = requiredEnv('STAGING_SUPABASE_URL');
  const projectRef = requiredEnv('STAGING_SUPABASE_PROJECT_REF');
  const anonKey = requiredEnv('STAGING_SUPABASE_ANON_KEY');
  const workspaceId = requiredEnv('STAGING_WORKSPACE_ID');
  const requesterId = requiredEnv('STAGING_TEST_USER_ID');
  const approverId = requiredEnv('STAGING_APPROVER_USER_ID');

  const parsedUrl = new URL(rawUrl);
  assert(/^[a-z0-9]{20}$/.test(projectRef), 'Staging project reference is invalid.');
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
  assert(UUID.test(workspaceId) && UUID.test(requesterId) && UUID.test(approverId),
    'Workspace and test-user inputs must be UUIDs.');
  assert(requesterId !== approverId,
    'Requester and approver must be different Auth users; self-approval is forbidden.');

  const baseUrl = parsedUrl.origin;
  const requesterClient = makeClient(baseUrl, anonKey);
  const approverClient = makeClient(baseUrl, anonKey);
  let taskId = null;

  try {
    const requester = await signIn(
      requesterClient,
      requiredEnv('STAGING_TEST_USER_EMAIL'),
      requiredEnv('STAGING_TEST_USER_PASSWORD'),
      requesterId,
      'Requester',
    );
    const approver = await signIn(
      approverClient,
      requiredEnv('STAGING_APPROVER_EMAIL'),
      requiredEnv('STAGING_APPROVER_PASSWORD'),
      approverId,
      'Approver',
    );
    await Promise.all([
      assertWorkspaceMember(requesterClient, workspaceId, requester.id, 'Requester'),
      assertWorkspaceMember(approverClient, workspaceId, approver.id, 'Approver'),
    ]);
    log('PASS two distinct authenticated workspace members are available for approval.');

    taskId = randomUUID();
    const initialEvent = {
      sequence: 1,
      eventType: 'task.created',
      actorId: requester.id,
      occurredAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      requestFingerprint: 'staging-invoice-acceptance:create:' + randomUUID(),
      statusAfter: 'Planning',
      attempt: 1,
      payload: {},
    };
    const created = await requesterClient.rpc('create_workflow_task', {
      p_task_id: taskId,
      p_workspace_id: workspaceId,
      p_title: 'STAGING E2E: synthetic invoice extraction acceptance',
      p_details: 'Synthetic invoice only. No customer, supplier, or real financial data is attached.',
      p_initial_event: initialEvent,
    });
    assert(!created.error && created.data === taskId,
      'Could not create the synthetic staging workflow task.');
    log('PASS dedicated synthetic task created: ' + taskId);

    const fileName = 'synthetic-invoice.pdf';
    const storagePath = workspaceId + '/' + taskId + '/' + randomUUID() + '/' + fileName;
    const pdf = createSyntheticInvoicePdf();
    const uploaded = await requesterClient.storage
      .from('workflow-files')
      .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false });
    assert(!uploaded.error, 'Could not upload the synthetic PDF to private staging storage.');

    const registered = await requesterClient.rpc('register_task_file', {
      p_workspace_id: workspaceId,
      p_task_id: taskId,
      p_file_name: fileName,
      p_storage_path: storagePath,
      p_content_type: 'application/pdf',
    });
    assert(!registered.error && typeof registered.data === 'string',
      'Could not register the private synthetic invoice attachment.');
    const fileId = registered.data;
    log('PASS synthetic PDF uploaded and registered in the private workflow-files bucket.');

    const approvalRequestId = randomUUID();
    await persistEvents(requesterClient, taskId, 1, 'Waiting for approval', [
      workflowEvent(2, 'status.changed', requester.id, 'Running', {
        from: 'Planning',
        to: 'Running',
      }),
      workflowEvent(3, 'status.changed', requester.id, 'Waiting for approval', {
        from: 'Running',
        to: 'Waiting for approval',
      }),
      workflowEvent(4, 'approval.requested', requester.id, 'Waiting for approval', {
        requestId: approvalRequestId,
      }),
    ]);
    log('PASS persisted approval request created before any invoice-provider call.');

    await persistEvents(approverClient, taskId, 4, 'Running', [
      workflowEvent(5, 'approval.recorded', approver.id, 'Waiting for approval', {
        result: {
          requestId: approvalRequestId,
          decision: 'approved',
          approverId: approver.id,
          decidedAt: new Date().toISOString(),
          reason: 'Approved synthetic invoice provider acceptance test.',
        },
      }),
      workflowEvent(6, 'status.changed', approver.id, 'Running', {
        from: 'Waiting for approval',
        to: 'Running',
      }),
    ]);
    const savedApproval = await requesterClient
      .from('task_approvals')
      .select('request_id, decision, requested_by, approver_id')
      .eq('task_id', taskId)
      .eq('request_id', approvalRequestId)
      .maybeSingle();
    assert(
      !savedApproval.error &&
        savedApproval.data?.decision === 'approved' &&
        savedApproval.data?.requested_by === requester.id &&
        savedApproval.data?.approver_id === approver.id &&
        savedApproval.data?.requested_by !== savedApproval.data?.approver_id,
      'A distinct, persisted approval could not be verified. The provider was not called.',
    );
    log('PASS distinct approver approval is persisted and verified.');

    const executionId = randomUUID();
    const requestId = randomUUID();
    const response = await postExecution(baseUrl, anonKey, requester.accessToken, {
      taskId,
      executionId,
      requestId,
      toolId: 'invoice-document-extract',
      toolVersion: '1.0.0',
      input: { fileId },
    });
    assert(
      response.status === 200 &&
        isRecord(response.body?.result) &&
        response.body.result.success === true,
      'Approved invoice execution failed (HTTP ' + response.status +
        ', code ' + executionErrorCode(response.body) +
        '). Check server-side invoice provider configuration.',
    );

    const matchedFields = validateReport(response.body.result.output);
    assert(response.body.workflowStatus === 'Verifying',
      'Successful extraction did not move the task to Verifying for independent human review.');

    log('PASS live PDF provider request completed; ' + matchedFields + '/8 synthetic fields matched.');
    log('PASS extraction remains explicitly human-review-required; no source invoice values were modified.');
    log('Evidence IDs — task: ' + taskId + ', execution: ' + executionId + ', attachment: ' + fileId);
    log('Provider/model/latency/usage acceptance must be correlated from provider_call_metrics after this run.');
    log('Synthetic task and attachment are retained in staging for audit; no email or external write was sent.');
  } finally {
    await Promise.all([
      requesterClient.auth.signOut({ scope: 'local' }).catch(() => undefined),
      approverClient.auth.signOut({ scope: 'local' }).catch(() => undefined),
    ]);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown staging invoice smoke failure.';
  process.stderr.write('FAIL ' + message + '\n');
  process.exitCode = 1;
}
