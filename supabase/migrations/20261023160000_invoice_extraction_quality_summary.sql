begin;

-- Report confidence-band patterns from human-reviewed invoice fields without exposing
-- the extracted or reviewed values. These are observed reviewer corrections, not
-- independently verified model accuracy or calibrated probabilities.
create or replace view public.invoice_extraction_confidence_summary
with (security_invoker = true)
as
select
  workspace_id,
  field_name,
  tool_version,
  case
    when confidence_estimate < 0.50 then '<0.50'
    when confidence_estimate < 0.70 then '0.50–0.69'
    when confidence_estimate < 0.80 then '0.70–0.79'
    when confidence_estimate < 0.90 then '0.80–0.89'
    else '0.90–1.00'
  end as confidence_band,
  case
    when confidence_estimate < 0.50 then 1
    when confidence_estimate < 0.70 then 2
    when confidence_estimate < 0.80 then 3
    when confidence_estimate < 0.90 then 4
    else 5
  end as confidence_band_order,
  count(*)::bigint as reviewed_field_count,
  count(*) filter (where is_correction)::bigint as corrected_field_count,
  count(*) filter (where not is_correction)::bigint as unchanged_field_count,
  round(
    count(*) filter (where is_correction)::numeric / nullif(count(*), 0),
    4
  ) as observed_correction_rate,
  round(avg(confidence_estimate), 4) as mean_reported_confidence
from public.invoice_extraction_feedback
group by
  workspace_id,
  field_name,
  tool_version,
  case
    when confidence_estimate < 0.50 then '<0.50'
    when confidence_estimate < 0.70 then '0.50–0.69'
    when confidence_estimate < 0.80 then '0.70–0.79'
    when confidence_estimate < 0.90 then '0.80–0.89'
    else '0.90–1.00'
  end,
  case
    when confidence_estimate < 0.50 then 1
    when confidence_estimate < 0.70 then 2
    when confidence_estimate < 0.80 then 3
    when confidence_estimate < 0.90 then 4
    else 5
  end;

revoke all on public.invoice_extraction_confidence_summary from public, anon;
grant select on public.invoice_extraction_confidence_summary to authenticated;

comment on view public.invoice_extraction_confidence_summary is
  'Workspace-scoped aggregate of observed human corrections by reported confidence band. This is a monitoring signal, not independently verified accuracy or confidence calibration.';

commit;
