// Approval alerts for the Studio5 Bill App.
//
// Phones register here (stored in public.push_subscriptions, so registrations survive restarts),
// and pg_cron calls this function to:
//   - mode "new":      alert within a minute when bills arrive in public.pending_approvals
//   - mode "reminder": a twice-daily nudge while anything is still waiting for approval
//
// Requests:
//   GET  ?action=public-key                                 -> { publicKey }  (VAPID key for pushManager.subscribe)
//   POST { action: "subscribe", subscription, user_name, wants_approval_alerts }   header x-app-secret
//   POST { mode: "new" | "reminder" }                        header x-cron-token  (from pg_cron only)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { generateVapidKeys, sendWebPush, type VapidKeys } from './webpush.ts';

// Same shared code the app page already sends to the Render backend (it is visible in the page).
const APP_SHARED_SECRET = 'studio5-field-2026';
const APP_URL = 'https://yadavs8.github.io/studio5-bill-app/';
const ALLOWED_ORIGIN = 'https://yadavs8.github.io';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, x-app-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const rupees = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

type Config = {
  vapid_public_key: string | null;
  vapid_private_jwk: JsonWebKey | null;
  cron_token: string;
  last_alerted_created_at: string;
};

async function loadConfig(): Promise<Config> {
  const { data, error } = await db.from('approval_alert_config').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as Config;
}

// The key pair is created once, on first use, and never leaves the database.
async function vapidKeys(config: Config): Promise<VapidKeys> {
  if (!config.vapid_public_key || !config.vapid_private_jwk) {
    const keys = await generateVapidKeys();
    const { data, error } = await db.from('approval_alert_config')
      .update({ vapid_public_key: keys.publicKey, vapid_private_jwk: keys.privateJwk })
      .eq('id', 1).is('vapid_public_key', null).select().maybeSingle();
    if (error) throw error;
    config = data ? (data as Config) : await loadConfig(); // another request may have created them first
  }
  return { publicKey: config.vapid_public_key!, privateJwk: config.vapid_private_jwk!, subject: APP_URL };
}

async function subscribe(body: Record<string, any>): Promise<Response> {
  const sub = body.subscription || {};
  const endpoint = String(sub.endpoint || '');
  const p256dh = sub.keys && String(sub.keys.p256dh || '');
  const auth = sub.keys && String(sub.keys.auth || '');
  if (!endpoint.startsWith('https://') || !p256dh || !auth) return json({ error: 'invalid subscription' }, 400);

  const { error } = await db.from('push_subscriptions').upsert({
    endpoint,
    p256dh,
    auth,
    user_name: body.user_name ? String(body.user_name).slice(0, 100) : null,
    wants_approval_alerts: !!body.wants_approval_alerts,
    last_seen_at: new Date().toISOString(),
    failed_attempts: 0,
  }, { onConflict: 'endpoint' });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

type Pending = { vendor_name: string | null; invoice_value: number | null; submitted_by_employee: string | null; created_at: string };

async function pendingBills(createdAfter?: string): Promise<Pending[]> {
  let query = db.from('pending_approvals')
    .select('vendor_name, invoice_value, submitted_by_employee, created_at')
    .eq('approval_status', 'pending');
  if (createdAfter) query = query.gt('created_at', createdAfter);
  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as Pending[];
}

async function notifyApprovers(message: { title: string; body: string }) {
  const config = await loadConfig();
  const vapid = await vapidKeys(config);
  const { data: subs, error } = await db.from('push_subscriptions')
    .select('endpoint, p256dh, auth, failed_attempts').eq('wants_approval_alerts', true);
  if (error) throw error;

  const payload = { ...message, url: './?view=approvals', tag: 'pending-approvals' };
  const results = await Promise.all((subs || []).map(async (s) => {
    let status = 0;
    try { status = await sendWebPush(s, payload, vapid); } catch (_) { /* network error — retried next run */ }
    if (status === 404 || status === 410) {
      await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint); // phone unsubscribed / app removed
    } else if (status >= 200 && status < 300) {
      await db.from('push_subscriptions').update({ last_sent_at: new Date().toISOString(), failed_attempts: 0 }).eq('endpoint', s.endpoint);
    } else {
      await db.from('push_subscriptions').update({ failed_attempts: (s.failed_attempts || 0) + 1 }).eq('endpoint', s.endpoint);
    }
    return status;
  }));
  return results;
}

async function alertNewBills(): Promise<Response> {
  const config = await loadConfig();
  const fresh = await pendingBills(config.last_alerted_created_at);
  if (fresh.length === 0) return json({ sent: 0, reason: 'no new bills' });

  // Claim these bills first so overlapping runs never alert twice for the same bills.
  const newest = fresh[fresh.length - 1].created_at;
  const { data: claimed, error } = await db.from('approval_alert_config')
    .update({ last_alerted_created_at: newest })
    .eq('id', 1).eq('last_alerted_created_at', config.last_alerted_created_at).select('id');
  if (error) throw error;
  if (!claimed || claimed.length === 0) return json({ sent: 0, reason: 'already handled' });

  const pending = await pendingBills();
  const waitingTotal = pending.reduce((s, b) => s + Number(b.invoice_value || 0), 0);
  const waitingLine = `${pending.length} waiting in total (${rupees(waitingTotal)}).`;
  let message;
  if (fresh.length === 1) {
    const b = fresh[0];
    message = {
      title: `🧾 New bill to approve: ${rupees(Number(b.invoice_value || 0))}`,
      body: `${b.vendor_name || 'Unknown vendor'}${b.submitted_by_employee ? ' · from ' + b.submitted_by_employee : ''}. ${waitingLine}`,
    };
  } else {
    const freshTotal = fresh.reduce((s, b) => s + Number(b.invoice_value || 0), 0);
    const names = fresh.slice(-3).reverse().map((b) => b.vendor_name || 'Unknown vendor').join(', ');
    message = {
      title: `🧾 ${fresh.length} new bills to approve (${rupees(freshTotal)})`,
      body: `${names}${fresh.length > 3 ? '…' : ''}. ${waitingLine}`,
    };
  }
  const results = await notifyApprovers(message);
  return json({ sent: results.filter((s) => s >= 200 && s < 300).length, devices: results.length });
}

async function remindPending(): Promise<Response> {
  const pending = await pendingBills();
  if (pending.length === 0) return json({ sent: 0, reason: 'nothing pending' });
  const total = pending.reduce((s, b) => s + Number(b.invoice_value || 0), 0);
  const oldestDays = Math.floor((Date.now() - new Date(pending[0].created_at).getTime()) / 86400000);
  const results = await notifyApprovers({
    title: `⏳ ${pending.length} bill${pending.length === 1 ? '' : 's'} waiting for your approval`,
    body: `${rupees(total)} in total${oldestDays >= 1 ? ` · oldest waiting ${oldestDays} day${oldestDays === 1 ? '' : 's'}` : ''}. Tap to review.`,
  });
  return json({ sent: results.filter((s) => s >= 200 && s < 300).length, devices: results.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    if (req.method === 'GET') {
      if (new URL(req.url).searchParams.get('action') !== 'public-key') return json({ error: 'unknown action' }, 400);
      return json({ publicKey: (await vapidKeys(await loadConfig())).publicKey });
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const body = await req.json().catch(() => ({}));
    if (body.action === 'subscribe') {
      if (req.headers.get('x-app-secret') !== APP_SHARED_SECRET) return json({ error: 'unauthorized' }, 401);
      return await subscribe(body);
    }

    const config = await loadConfig();
    if (!req.headers.get('x-cron-token') || req.headers.get('x-cron-token') !== config.cron_token) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (body.mode === 'new') return await alertNewBills();
    if (body.mode === 'reminder') return await remindPending();
    return json({ error: 'unknown mode' }, 400);
  } catch (e) {
    console.error('approval-alerts failed:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
