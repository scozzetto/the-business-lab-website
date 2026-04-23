/**
 * Business Lab — PandaDoc webhook receiver
 *
 * Listens for: document_state_changed (status: document.completed)
 * On receive:
 *   1. Verify HMAC-SHA256 signature (if PANDADOC_WEBHOOK_SECRET is set)
 *   2. Find or create Stripe customer
 *   3. Create subscription with trial anchored to 1st of next month
 *   4. Create Stripe Checkout session (setup mode) for payment method capture (autopay only)
 *   5. Email checkout link to client
 *
 * Env vars: PANDADOC_WEBHOOK_SECRET (optional but recommended), STRIPE_SECRET_KEY,
 *           BL_ADMIN_EMAIL, GMAIL_USER, GMAIL_APP_PASSWORD
 *
 * Register at: PandaDoc → Dev Center → Configuration → Webhooks → Create webhook
 * URL: https://thebusiness-lab.com/.netlify/functions/bl-signup-webhook
 * Events to subscribe: document_state_changed
 */

const crypto = require('crypto');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'POST only' };
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
        console.error('Missing env: STRIPE_SECRET_KEY');
        return { statusCode: 200, body: 'ok' };
    }

    // ── Parse raw body ────────────────────────────────────────────────────────
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');

    // ── HMAC verification ─────────────────────────────────────────────────────
    // PandaDoc sends X-PandaDoc-Signature: base64(HMAC-SHA256(secret, raw_body))
    const webhookSecret = process.env.PANDADOC_WEBHOOK_SECRET;
    if (webhookSecret) {
        const receivedSig = (
            event.headers['x-pandadoc-signature'] ||
            event.headers['X-PandaDoc-Signature'] || ''
        ).trim();
        if (receivedSig) {
            // Only reject if a signature was actually sent but doesn't match
            const expectedSig = crypto
                .createHmac('sha256', webhookSecret)
                .update(rawBody)
                .digest('base64');
            if (receivedSig !== expectedSig) {
                console.error('Webhook HMAC mismatch. Received:', receivedSig, 'Expected:', expectedSig);
                return { statusCode: 200, body: 'ok' };
            }
        } else {
            console.log('Webhook: no signature header — processing without verification');
        }
    }

    // ── Parse JSON payload ────────────────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (e) {
        console.error('Webhook: failed to parse JSON:', e.message);
        return { statusCode: 200, body: 'ok' };
    }

    const eventType = payload.event;
    const data      = payload.data || {};

    console.log('PandaDoc webhook received:', eventType, '| status:', data.status, '| doc:', data.id);

    // Only process completed documents
    if (eventType !== 'document_state_changed' || data.status !== 'document.completed') {
        return { statusCode: 200, body: 'ok' };
    }

    try {
        await handleDocumentCompleted(data, stripeKey);
    } catch (err) {
        console.error('handleDocumentCompleted failed:', err.message, err.stack);
        // Still ACK — we don't want PandaDoc hammering retries. Investigate in logs.
    }

    return { statusCode: 200, body: 'ok' };
};

// ─────────────────────────────────────────────────────────────────────────────

async function handleDocumentCompleted(data, stripeKey) {
    const stripe = require('stripe')(stripeKey);

    const documentId = data.id || '';
    const meta       = data.metadata || {};

    // ── Client info from recipients ───────────────────────────────────────────
    const recipients  = data.recipients || [];
    const signer      = recipients.find(r => r.role === 'Client') || recipients[0] || {};
    const signerEmail = signer.email      || '';
    const signerName  = ((signer.first_name || '') + ' ' + (signer.last_name || '')).trim();
    const company     = meta.company      || '';
    const clientType  = meta.client_type  || 'individual';
    const isCompany   = clientType === 'company';

    // Rep fields — stored as a JSON blob to keep Stripe metadata tidy
    let repBlob = {};
    try { repBlob = meta.rep ? JSON.parse(meta.rep) : {}; } catch (_) { repBlob = {}; }
    const repFirstName = repBlob.first || meta.rep_first_name || '';
    const repLastName  = repBlob.last  || meta.rep_last_name  || '';
    const repEmail     = repBlob.email || meta.rep_email      || '';
    const repPhone     = repBlob.phone || meta.rep_phone      || '';

    const clientEmail = signerEmail;
    const clientName  = isCompany ? (company || signerName) : signerName;

    const notes     = (meta.notes     || '').slice(0, 500);
    const startDate = meta.start_date || '';
    const existingCustomerId = meta.customer_id || '';

    // ── Parse items ───────────────────────────────────────────────────────────
    // New compact format: item0 = "priceId:category[:hours]", item1 = ...
    let items = [];
    const compactKeys = Object.keys(meta).filter(k => /^item\d+$/.test(k)).sort();
    if (compactKeys.length > 0) {
        items = compactKeys.map(k => {
            const parts = (meta[k] || '').split(':');
            const cat   = parts[1] || 'package';
            return {
                priceId:  parts[0] || '',
                category: cat,
                amount:   (cat === 'enterprise' && parts[2]) ? parseInt(parts[2]) : 0,
                name:     ''
            };
        }).filter(i => i.priceId || i.category === 'enterprise');
    } else {
        // Legacy JSON format
        try { items = JSON.parse(meta.items || '[]'); } catch (_) { items = []; }
        // Backwards compat with old single-price envelopes
        if (items.length === 0 && meta.stripe_price_id) {
            items = [{ priceId: meta.stripe_price_id, category: 'retainer', name: meta.tier || 'Retainer', amount: 0 }];
        }
    }

    const retainers  = items.filter(i => i.category === 'retainer');
    const packages   = items.filter(i => i.category === 'package');
    const hourly     = items.filter(i => i.category === 'hourly');
    const enterprise = items.filter(i => i.category === 'enterprise');

    if (!clientEmail) throw new Error('No client email in webhook payload');
    if (items.length === 0) throw new Error('No items in webhook metadata');

    const collectionMethod = meta.collection_method || 'charge_automatically';
    const paymentMethod    = meta.payment_method    || 'card';
    const pmTypes = paymentMethod === 'ach'
        ? ['us_bank_account', 'card']
        : ['card', 'us_bank_account'];

    console.log(`Processing signup: ${clientName} <${clientEmail}> retainers=${retainers.length} packages=${packages.length} enterprise=${enterprise.length} addons=${hourly.length} docId=${documentId}`);

    // ── Idempotency — don't double-create if webhook fires twice ─────────────
    const [existingSubs, existingInvs] = await Promise.all([
        stripe.subscriptions.search({
            query: `metadata['document_id']:'${documentId}'`,
            limit: 1
        }).catch(() => ({ data: [] })),
        stripe.invoices.search({
            query: `metadata['document_id']:'${documentId}'`,
            limit: 1
        }).catch(() => ({ data: [] }))
    ]);
    if ((existingSubs.data && existingSubs.data.length) || (existingInvs.data && existingInvs.data.length)) {
        console.log('Duplicate webhook — already processed documentId:', documentId);
        return;
    }

    // ── Find or create Stripe customer ────────────────────────────────────────
    let customerId = existingCustomerId;
    if (!customerId) {
        const found = await stripe.customers.list({ email: clientEmail, limit: 5 });
        // Reuse an existing customer only if they're not flagged as an active lead
        const reuse = found.data.find(c => !c.metadata.bl_lead_status);
        if (reuse) {
            customerId = reuse.id;
            console.log('Reusing existing customer:', customerId);
        } else {
            const customerMeta = {
                company,
                document_id: documentId,
                client_type: clientType
            };
            if (isCompany) {
                if (repFirstName) customerMeta.rep_first_name = repFirstName;
                if (repLastName)  customerMeta.rep_last_name  = repLastName;
                if (repEmail)     customerMeta.rep_email      = repEmail;
                if (repPhone)     customerMeta.rep_phone      = repPhone;
            }
            const custParams = {
                email:    clientEmail,
                name:     clientName,
                metadata: customerMeta
            };
            if (repPhone) custParams.phone = repPhone;
            const newCust = await stripe.customers.create(custParams);
            customerId = newCust.id;
            console.log('Created customer:', customerId, isCompany ? '(company)' : '(individual)');
        }
    }

    // ── Retainers + packages + enterprise → one Stripe subscription ──────────
    let checkoutUrl = null;
    const monthlyItems = [...retainers, ...packages, ...enterprise];
    if (monthlyItems.length > 0) {
        const trialEnd = computeTrialEnd();
        console.log('Trial end:', new Date(trialEnd * 1000).toISOString());

        // For enterprise items with no priceId, create a real product + monthly price + annual price
        for (const ent of enterprise) {
            if (!ent.priceId && ent.amount > 0) {
                const engProduct = await stripe.products.create({
                    name: `Enterprise — ${clientName}`,
                    metadata: { bl_category: 'enterprise', bl_billing: 'monthly', document_id: documentId }
                });
                const monthlyPrice = await stripe.prices.create({
                    product:    engProduct.id,
                    unit_amount: ent.amount,
                    currency:   'usd',
                    recurring:  { interval: 'month' },
                    metadata:   { bl_category: 'enterprise', bl_billing: 'monthly', document_id: documentId }
                });
                // Also seed the annual price (10% off) for Phase 2B payment-page toggle
                await stripe.prices.create({
                    product:    engProduct.id,
                    unit_amount: Math.round(ent.amount * 12 * 0.90),
                    currency:   'usd',
                    recurring:  { interval: 'year' },
                    metadata:   { bl_category: 'enterprise', bl_billing: 'annual', bl_discount: '10pct', document_id: documentId }
                });
                ent.priceId = monthlyPrice.id; // subscription uses monthly; customer can switch in Phase 2B
                console.log(`Enterprise product created: ${engProduct.id}, monthly: ${monthlyPrice.id}`);
            }
        }

        // Build subscription line items (all items now have priceId)
        const subItems = monthlyItems.filter(i => i.priceId).map(i => ({ price: i.priceId }));
        if (subItems.length === 0) throw new Error('Monthly items missing priceId');

        const subParams = {
            customer:          customerId,
            items:             subItems,
            trial_end:         trialEnd,
            payment_behavior:  'default_incomplete',
            collection_method: collectionMethod,
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: pmTypes
            },
            metadata: {
                document_id: documentId,
                notes
            }
        };
        if (collectionMethod === 'send_invoice') {
            subParams.days_until_due = 15;
        }

        const subscription = await stripe.subscriptions.create(subParams);
        console.log('Subscription created:', subscription.id, 'status:', subscription.status);

        // Autopay: create Checkout session for payment method capture
        if (collectionMethod === 'charge_automatically') {
            const setupOpts = {
                mode:                 'setup',
                customer:             customerId,
                payment_method_types: pmTypes,
                setup_intent_data: {
                    metadata: { subscription_id: subscription.id, customer_id: customerId }
                },
                success_url: 'https://thebusiness-lab.com/payment-confirmed?session_id={CHECKOUT_SESSION_ID}',
                cancel_url:  'https://thebusiness-lab.com',
                metadata:    { subscription_id: subscription.id }
            };
            if (pmTypes.includes('us_bank_account')) {
                setupOpts.payment_method_options = {
                    us_bank_account: { financial_connections: { permissions: ['payment_method'] } }
                };
            }
            const session = await stripe.checkout.sessions.create(setupOpts);
            checkoutUrl = session.url;
            console.log('Checkout session created:', session.id);
        }
        // Invoice mode: Stripe auto-emails first invoice (configured in Billing settings)
    }

    // ── Add-ons → one-time invoice, finalized and sent immediately ───────────
    if (hourly.length > 0) {
        try {
            const addonInv = await stripe.invoices.create({
                customer:          customerId,
                collection_method: collectionMethod,
                ...(collectionMethod === 'send_invoice' ? { days_until_due: 15 } : {}),
                metadata: { document_id: documentId, invoice_type: 'addon' }
            });
            for (const item of hourly) {
                await stripe.invoiceItems.create({
                    customer:    customerId,
                    invoice:     addonInv.id,
                    unit_amount: item.amount || 0,
                    quantity:    1,
                    currency:    'usd',
                    description: item.name || 'Add-On Service'
                });
            }
            const finalizedInv = await stripe.invoices.finalizeInvoice(addonInv.id);
            if (collectionMethod === 'charge_automatically') {
                await stripe.invoices.pay(finalizedInv.id).catch(e =>
                    console.warn('Add-on invoice autopay failed (no PM yet):', e.message)
                );
            } else {
                await stripe.invoices.sendInvoice(finalizedInv.id).catch(e =>
                    console.warn('Add-on invoice send failed:', e.message)
                );
            }
            console.log('Add-on invoice created and sent:', finalizedInv.id, 'items:', hourly.map(i => i.name).join(', '));
        } catch (err) {
            console.error('Add-on invoice creation failed:', err.message);
        }
    }

    // ── Welcome email ─────────────────────────────────────────────────────────
    const greetingName = isCompany
        ? (repFirstName || signerName || clientName)
        : signerName;
    await sendEmail({
        to:         clientEmail,
        name:       greetingName,
        retainers,
        packages,
        enterprise,
        hourly,
        checkoutUrl,
        trialEnd:   monthlyItems.length > 0 ? computeTrialEnd() : null
    });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns Unix timestamp for next 1st of month at 00:00 UTC, at least 14 days out.
 */
function computeTrialEnd() {
    const min = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const y = min.getUTCFullYear();
    const m = min.getUTCMonth();
    const d = min.getUTCDate();
    const next1st = (d === 1 && min.getUTCHours() === 0 && min.getUTCMinutes() === 0)
        ? new Date(Date.UTC(y, m, 1))
        : new Date(Date.UTC(y, m + 1, 1));
    return Math.floor(next1st.getTime() / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail({ to, name, retainers = [], packages = [], enterprise = [], hourly = [], checkoutUrl, trialEnd }) {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPass) {
        console.warn('Email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set. checkoutUrl:', checkoutUrl);
        return;
    }

    const nodemailer  = require('nodemailer');
    const transport   = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass }
    });

    const firstName = (name || '').split(' ')[0] || name || 'there';
    const trialEndStr = trialEnd
        ? new Date(trialEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        : null;

    let actionBlocks = '';

    if (checkoutUrl && (retainers.length > 0 || packages.length > 0 || enterprise.length > 0)) {
        const monthlyNames = [...retainers, ...packages, ...enterprise].map(r => escHtml(r.name || 'Service')).join(', ');
        actionBlocks += `
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <p style="margin:0 0 6px;font-size:14px;font-weight:600">Step 1 — Add your payment method</p>
    <p style="margin:0 0 12px;font-size:13px;color:#475569">Required for: ${monthlyNames}${trialEndStr ? `. Your trial runs until <strong>${trialEndStr}</strong> — no charge until then.` : '.'}</p>
    <a href="${checkoutUrl}" style="display:inline-block;background:#d4af37;color:#0f172a;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Add Payment Method →</a>
    <p style="font-size:12px;color:#94a3b8;margin:8px 0 0">Can't click? <a href="${checkoutUrl}" style="color:#2563eb;word-break:break-all">${checkoutUrl}</a></p>
  </div>`;
    }

    if (hourly.length > 0) {
        const addonNames = hourly.map(i => escHtml(i.name || 'Add-On')).join(', ');
        actionBlocks += `
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <p style="margin:0 0 6px;font-size:14px;font-weight:600">Add-On Invoice</p>
    <p style="margin:0;font-size:13px;color:#475569">An invoice for your one-time add-on service(s) — <strong>${addonNames}</strong> — has been sent separately. Please check your inbox.</p>
  </div>`;
    }

    if (!actionBlocks) {
        actionBlocks = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:20px"><p style="margin:0;font-size:14px;color:#16a34a;font-weight:600">Your engagement is now active. We'll be in touch shortly.</p></div>`;
    }

    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <div style="border-bottom:3px solid #d4af37;padding-bottom:16px;margin-bottom:24px">
    <div style="font-size:18px;font-weight:700;color:#0f172a">The Business <span style="color:#d4af37">Lab</span></div>
    <div style="font-size:11px;color:#64748b">Strategy &middot; Finance &middot; Marketing &middot; Legal &middot; Technology</div>
  </div>
  <h1 style="font-size:22px;font-weight:700;color:#0f172a;margin:0 0 6px">Welcome, ${escHtml(firstName)}!</h1>
  <p style="color:#64748b;font-size:14px;margin:0 0 24px">Your Master Services Agreement has been signed. Here's what's next:</p>
  ${actionBlocks}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px">
  <p style="font-size:12px;color:#94a3b8;margin:0">
    Questions? Reply to this email or call 248-775-5058.<br>
    The Business Lab &middot; <a href="https://thebusiness-lab.com" style="color:#94a3b8">thebusiness-lab.com</a>
  </p>
</div>`.trim();

    await transport.sendMail({
        from:    `The Business Lab <${gmailUser}>`,
        to,
        subject: 'Welcome to The Business Lab — Next steps inside',
        html
    });

    console.log('Welcome email sent to', to);
}

function escHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
