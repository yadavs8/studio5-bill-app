-- Keep a bill's tax breakup through approval (audit H3, studio5-bill-backened/.rea/audit.md).
-- pending_approvals stored only the total, so every bill approved through the app reached the ledger
-- with taxable value / CGST / SGST / IGST = 0, and the GSTR-2B export and the CA packet's input tax credit
-- were wrong. The backend now sends these fields; until this runs it simply leaves them out.
-- Additive only: no existing row or column changes. Safe to run again.
-- Rollback: alter table public.pending_approvals drop column if exists <each column below>;
begin;
alter table public.pending_approvals
  add column if not exists seller_address text,
  add column if not exists seller_phone text,
  add column if not exists description text,
  add column if not exists place_of_supply text,
  add column if not exists taxable_value numeric(14,2),
  add column if not exists igst numeric(14,2),
  add column if not exists cgst numeric(14,2),
  add column if not exists sgst numeric(14,2),
  add column if not exists cess numeric(14,2),
  add column if not exists payment_mode text,
  add column if not exists bill_time text,
  add column if not exists gstin_status text,
  add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.bills
  add column if not exists gstin_status text,
  add column if not exists items jsonb not null default '[]'::jsonb;
commit;
