-- Validate the self-approval invariant against all existing approval records.
-- The NOT VALID constraint has already enforced the rule for new or changed rows.
alter table public.task_approvals
  validate constraint task_approvals_no_self_approval;
