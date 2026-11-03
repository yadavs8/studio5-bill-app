-- Flag bills that are waiting more than once (the same bill sent twice, e.g. once on
-- WhatsApp and once in the app), so the boss approves one copy and rejects the rest.
create or replace function public.pending_approvals_for_app()
returns jsonb
language sql
stable
set search_path = public
as $$
  with p as (
    select * from pending_approvals where approval_status = 'pending'
  ),
  norm as (
    select p.*,
      lower(regexp_replace(coalesce(p.bill_no, ''), '[^a-zA-Z0-9]', '', 'g')) as clean_bno,
      upper(trim(coalesce(p.gstin, ''))) as clean_gstin,
      lower(trim(coalesce(p.vendor_name, ''))) as clean_vendor
    from p
  )
  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
  from (
    select n.created_at, jsonb_build_object(
      'submission_id', n.submission_id,
      'bill_type', n.bill_type,
      'vendor_name', coalesce(n.vendor_name, ''),
      'gstin', coalesce(n.gstin, ''),
      'bill_no', coalesce(n.bill_no, ''),
      'date', coalesce(to_char(n.bill_date, 'DD/MM/YYYY'), ''),
      'invoice_value', coalesce(trim_scale(n.invoice_value)::text, ''),
      'purchased_by', coalesce(n.purchased_by, ''),
      'submitted_by_employee', coalesce(n.submitted_by_employee, ''),
      'photo_link', coalesce(n.photo_link, ''),
      'payment_status', coalesce(n.payment_status, ''),
      'description', '',
      'gstin_status', '',
      'gstin_status_detail', '',
      'items', '[]'::jsonb,
      'price_alerts', '[]'::jsonb,
      -- Other waiting submissions of the same bill, by the same rule as the ledger check below.
      'same_bill_pending', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'submission_id', o.submission_id,
          'submitted_by', coalesce(nullif(o.submitted_by_employee, ''), o.purchased_by, ''),
          'submitted_on', to_char(o.created_at, 'DD/MM/YYYY'),
          'is_older', o.created_at < n.created_at) order by o.created_at), '[]'::jsonb)
        from norm o
        where o.submission_id <> n.submission_id
          and ((n.clean_bno <> '' and n.clean_bno = o.clean_bno
                and ((n.clean_gstin <> '' and n.clean_gstin = o.clean_gstin)
                  or (n.clean_vendor <> '' and n.clean_vendor = o.clean_vendor)))
            or (n.clean_vendor <> '' and n.clean_vendor = o.clean_vendor
                and round(coalesce(n.invoice_value, 0)) > 0 and round(n.invoice_value) = round(coalesce(o.invoice_value, 0))
                and n.bill_date is not null and n.bill_date = o.bill_date))),
      -- Same rule as the app's own check: same bill number from the same GSTIN or vendor,
      -- or same vendor + amount + date, already in the ledger.
      'duplicate_warning', (
        select jsonb_build_object(
          'is_duplicate', true,
          'existing_id', b.id,
          'existing_bill_no', b.bill_no,
          'existing_vendor', b.vendor_name,
          'existing_amount', b.invoice_value,
          'existing_date', b.bill_date,
          'existing_status', b.payment_status,
          'existing_purchased_by', coalesce(b.purchased_by, b.submitted_by_employee))
        from bills b
        where (
            n.clean_bno <> ''
            and n.clean_bno = lower(regexp_replace(coalesce(b.bill_no, ''), '[^a-zA-Z0-9]', '', 'g'))
            and ((n.clean_gstin <> '' and n.clean_gstin = upper(trim(coalesce(b.gstin, ''))))
              or (n.clean_vendor <> '' and n.clean_vendor = lower(trim(coalesce(b.vendor_name, '')))))
          ) or (
            n.clean_vendor <> '' and n.clean_vendor = lower(trim(coalesce(b.vendor_name, '')))
            and round(coalesce(n.invoice_value, 0)) > 0 and round(n.invoice_value) = round(coalesce(b.invoice_value, 0))
            and n.bill_date is not null and n.bill_date = b.bill_date
          )
        order by b.id desc
        limit 1)
    ) as item
    from norm n
  ) rows;
$$;

revoke all on function public.pending_approvals_for_app() from public, anon, authenticated;
