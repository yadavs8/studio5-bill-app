-- Approval alerts: phone registrations and alert state live in the database, so they survive
-- backend restarts. Only the approval-alerts Edge Function (service role) reads or writes them.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.push_subscriptions (
  endpoint              text primary key,
  p256dh                text not null,
  auth                  text not null,
  user_name             text,
  wants_approval_alerts boolean not null default false,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  last_sent_at          timestamptz,
  failed_attempts       integer not null default 0
);

create table public.approval_alert_config (
  id                      integer primary key default 1 check (id = 1),
  vapid_public_key        text,
  vapid_private_jwk       jsonb,
  cron_token              text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  -- Bills created up to this moment have already been alerted (or predate the alerts).
  last_alerted_created_at timestamptz not null default now()
);
insert into public.approval_alert_config (id) values (1);

alter table public.push_subscriptions enable row level security;
alter table public.approval_alert_config enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.approval_alert_config from anon, authenticated;

-- Fast lookup of what is waiting, used every minute by the alert check.
create index if not exists pending_approvals_pending_created_at_idx
  on public.pending_approvals (created_at) where approval_status = 'pending';
