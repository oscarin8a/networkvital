// netlify/functions/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  let ev;
  try {
    ev = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const SB  = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  const hdr = {
    'apikey': KEY, 'Authorization': `Bearer ${KEY}`,
    'Content-Type': 'application/json', 'Prefer': 'return=minimal'
  };

  const patch = async (filter, data) => {
    await fetch(`${SB}/rest/v1/membresias?${filter}`, {
      method: 'PATCH', headers: hdr, body: JSON.stringify(data)
    });
  };

  const getMemId = async (cid) => {
    const r = await fetch(`${SB}/rest/v1/membresias?stripe_customer_id=eq.${cid}&select=id`,
      { headers: { 'apikey': KEY, 'Authorization': `Bearer ${KEY}` } });
    const rows = await r.json();
    return rows?.[0]?.id || null;
  };

  const insertPago = async (membresiaId, paymentId, monto, status) => {
    await fetch(`${SB}/rest/v1/pagos`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ membresia_id: membresiaId, stripe_payment_id: paymentId, monto_usd: monto, status })
    });
  };

  try {
    switch (ev.type) {
      case 'invoice.payment_succeeded': {
        const inv = ev.data.object;
        const renovacion = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await patch(`stripe_customer_id=eq.${inv.customer}`, {
          status: 'activa',
          stripe_sub_id: inv.subscription,
          fecha_inicio: new Date().toISOString(),
          fecha_renovacion: renovacion,
        });
        const mid = await getMemId(inv.customer);
        if (mid) await insertPago(mid, inv.payment_intent, (inv.amount_paid||4900)/100, 'exitoso');
        break;
      }
      case 'invoice.payment_failed': {
        const inv = ev.data.object;
        const mid = await getMemId(inv.customer);
        if (mid) await insertPago(mid, inv.payment_intent, (inv.amount_due||4900)/100, 'fallido');
        break;
      }
      case 'customer.subscription.deleted': {
        await patch(`stripe_customer_id=eq.${ev.data.object.customer}`, { status: 'cancelada' });
        break;
      }
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    return { statusCode: 500, body: 'Server Error' };
  }
};
