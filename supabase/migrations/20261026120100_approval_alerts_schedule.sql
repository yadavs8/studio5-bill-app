-- Every minute: alert approvers about bills that arrived since the last alert. The HTTP call
-- only happens when there is something new and at least one phone wants alerts.
select cron.schedule('approval-alerts-new-bills', '* * * * *', $job$
  select net.http_post(
    url := 'https://vxnbqctughowcrvruvyb.supabase.co/functions/v1/approval-alerts',
    body := '{"mode":"new"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', c.cron_token))
  from public.approval_alert_config c
  where exists (select 1 from public.pending_approvals p
                where p.approval_status = 'pending' and p.created_at > c.last_alerted_created_at)
    and exists (select 1 from public.push_subscriptions s where s.wants_approval_alerts);
$job$);

-- 10:00 and 18:00 IST (04:30 and 12:30 UTC): reminder while anything is still waiting.
select cron.schedule('approval-alerts-reminders', '30 4,12 * * *', $job$
  select net.http_post(
    url := 'https://vxnbqctughowcrvruvyb.supabase.co/functions/v1/approval-alerts',
    body := '{"mode":"reminder"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', c.cron_token))
  from public.approval_alert_config c
  where exists (select 1 from public.pending_approvals p where p.approval_status = 'pending')
    and exists (select 1 from public.push_subscriptions s where s.wants_approval_alerts);
$job$);
