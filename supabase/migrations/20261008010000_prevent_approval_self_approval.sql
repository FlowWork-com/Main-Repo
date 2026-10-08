alter table public.task_approvals
  add constraint task_approvals_no_self_approval
  check (
    decision is distinct from 'approved'
    or requested_by is distinct from approver_id
  ) not valid;
