/**
 * Business Lab — Dropbox Sign webhook receiver
 *
 * Listens for: signature_request_all_signed
 * On receive:
 *   1. Verify HMAC signature
 *   2. Find or create Stripe customer
 *   3. Create subscription with 14-day trial anchored to 1st of month
 *   4. Create Stripe Checkout session (setup mode) for payment method capture
 *   5. Email checkout link to client
 *
 * Env vars: HELLOSIGN_API_KEY, STRIPE_SECRET_KEY, BL_ADMIN_EMAIL,
 *           GMAIL_USER, GMAIL_APP_PASSWORD
 *
 * Register at: Dropbox Sign → Settings → API → Account callback
 * URL: https://thebusiness-lab.com/.netlify/functions/bl-signup-webhook
 */

const crypto    = require('crypto');
const querystring = require('querystring');

// Dropbox Sign requires this exact ACK string or it will retry the webhook.
const DS_ACK = 'Hello API Event Received';

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'POST only' };
    }

    const hsKey     = process.env.HELLOSIGN_API_KEY;
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (!hsKey || !stripeKey) {
        console.error('Missing env: HELLOSIGN_API_KEY or STRIPE_SECRET_KEY');
        // ACK anyway so Dropbox Sign stops retrying; the error is in logs.
        return { statusCode: 200, body: DS_ACK };
    }

    // ── Parse form-encoded body ───────────────────────────────────────────────
    // Dropbox Sign POSTs: Content-Type: application/x-www-form-urlencoded
    //   body = json=<url-encoded JSON string>
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');

    const parsed  = querystring.parse(rawBody);
    const jsonStr = parsed.json || '';

    if (!jsonStr) {
        console.error('Webhook: no json field in body');
        return { statusCode: 200, body: DS_ACK };
    }

    // ── HMAC verification ─────────────────────────────────────────────────────
    // Hash header = HMAC-SHA256(json_field_value, api_key), lowercase hex
    const receivedHash = (
        event.headers['Hash']  ||
        event.headers['hash']  ||
        ''
    ).toLowerCase().trim();

    const expectedHash = crypto
        .createHmac('sha256', hsKey)
        .update(jsonStr)
        .digest('hex');

    if (!receivedHash || receivedHash !== expectedHash) {
        console.error('Webhook HMAC mismatch. Received:', receivedHash, 'Expected:', expectedHash);
        return { statusCode: 403, body: 'Invalid webhook signature' };
    }

    // ── Parse payload ─────────────────────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(jsonStr);
    } catch (e) {
        console.error('Webhook: failed to parse JSON:', e.message);
        return { statusCode: 200, body: DS_ACK };
    }

    const eventType = (payload.event || {}).event_type;
    console.log('Dropbox Sign event received:', eventType);

    // Only handle the fully-signed event; ACK everything else silently.
    if (eventType !== 'signature_request_all_signed') {
        return { statusCode: 200, body: DS_ACK };
    }

    // Route test envelopes to STRIPE_TEST_KEY if configured; otherwise fall
    // through to the live key (test subs are cheap but still real objects).
    const sr          = payload.signature_request || {};
    const isTestEnv   = !!(sr.test_mode || sr.is_test_signature);
    const activeKey   = (isTestEnv && process.env.STRIPE_TEST_KEY)
        ? process.env.STRIPE_TEST_KEY
        : stripeKey;

    if (isTestEnv && !process.env.STRIPE_TEST_KEY) {
        console.warn('Test envelope received but STRIPE_TEST_KEY not set — using live key. Add STRIPE_TEST_KEY in Netlify env vars to avoid live objects during testing.');
    }

    try {
        await handleAllSigned(payload, activeKey);
    } catch (err) {
        // Log but still ACK — we don't want Dropbox Sign hammering retries.
        // Investigate in Netlify function logs.
        console.error('handleAllSigned failed:', err.message, err.stack);
    }

    return { statusCode: 200, body: DS_ACK };
};

// ─────────────────────────────────────────────────────────────────────────────

async function handleAllSigned(payload, stripeKey) {
    const stripe = require('stripe')(stripeKey);

    const sr                = payload.signature_request || {};
    const meta              = sr.metadata || {};
    const signatureRequestId = sr.signature_request_id || '';

    // ── Metadata from the Dropbox Sign envelope (set in bl-signup.js) ─────────
    const tier               = meta.tier              || '';
    const stripePriceId      = meta.stripe_price_id   || '';
    const notes              = (meta.notes            || '').slice(0, 500);
    const existingCustomerId = meta.customer_id       || '';
    let   addons             = [];
    try { addons = JSON.parse(meta.addons || '[]'); } catch (_) { addons = []; }

    // ── Client info from the signer list ─────────────────────────────────────
    const signers     = sr.signatures || [];
    const signer      = signers[0]    || {};
    const clientEmail = signer.signer_email_address || '';
    const clientName  = signer.signer_name          || '';
    const company     = meta.company || '';

    if (!clientEmail)   throw new Error('No client email in webhook payload');
    if (!stripePriceId) throw new Error('No stripe_price_id in webhook metadata');

    console.log(`Processing signup: ${clientName} <${clientEmail}> tier=${tier} sigId=${signatureRequestId}`);

    // ── Idempotency check: skip if we already have a sub for this envelope ────
    const existingSubs = await stripe.subscriptions.search({
        query: `metadata['signature_request_id']:'${signatureRequestId}'`,
        limit: 1
    }).catch(() => ({ data: [] })); // search not available on all accounts — safe fallback

    if (existingSubs.data && existingSubs.data.length > 0) {
        console.log('Duplicate webhook — subscription already created:', existingSubs.data[0].id);
        return;
    }

    // ── Find or create Stripe customer ────────────────────────────────────────
    let customerId = existingCustomerId;
    if (!customerId) {
        const found = await stripe.customers.list({ email: clientEmail, limit: 1 });
        if (found.data.length > 0) {
            customerId = found.data[0].id;
            console.log('Reusing existing customer:', customerId);
        } else {
            const newCust = await stripe.customers.create({
                email:    clientEmail,
                name:     clientName,
                metadata: { company, tier, signature_request_id: signatureRequestId }
            });
            customerId = newCust.id;
            console.log('Created customer:', customerId);
        }
    }

    // ── Compute trial_end: 14 days from now, rounded UP to next 1st of month ─
    const trialEnd = computeTrialEnd();
    console.log('Trial end:', new Date(trialEnd * 1000).toISOString());

    // ── Build subscription items ──────────────────────────────────────────────
    // Tier price is the required item; addon price IDs are optional extras.
    const items = [{ price: stripePriceId }];
    addons.forEach(function(addon) {
        if (addon.priceId) items.push({ price: addon.priceId });
    });

    // ── Create Stripe subscription ────────────────────────────────────────────
    const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items,
        trial_end,
        payment_behavior: 'default_incomplete',
        payment_settings: {
            save_default_payment_method: 'on_subscription',
            payment_method_types: ['card', 'us_bank_account']
        },
        metadata: {
            signature_request_id: signatureRequestId,
            tier,
            notes
        }
    });
    console.log('Subscription created:', subscription.id, 'status:', subscription.status);

    // ── Create Checkout session (setup mode) to collect payment method ────────
    // Phase 2B will add a custom branded page with cycle-selection (monthly vs annual).
    // For now, Stripe-hosted setup captures the payment method (card + ACH).
    const session = await stripe.checkout.sessions.create({
        mode:     'setup',
        customer: customerId,
        payment_method_types: ['card', 'us_bank_account'],
        payment_method_options: {
            us_bank_account: {
                financial_connections: { permissions: ['payment_method'] }
            }
        },
        setup_intent_data: {
            metadata: {
                subscription_id: subscription.id,
                customer_id:     customerId
            }
        },
        success_url: 'https://thebusiness-lab.com/payment-confirmed?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:  'https://thebusiness-lab.com',
        metadata:    { subscription_id: subscription.id }
    });
    console.log('Checkout session created:', session.id);

    // ── Email checkout link to client ─────────────────────────────────────────
    await sendEmail({
        to:         clientEmail,
        name:       clientName,
        tier,
        checkoutUrl: session.url,
        trialEnd
    });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a Unix timestamp for the next 1st of the month at 00:00:00 UTC,
 * at least 14 days from now.
 */
function computeTrialEnd() {
    const now      = new Date();
    const min      = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // +14 days

    const y = min.getUTCFullYear();
    const m = min.getUTCMonth();
    const d = min.getUTCDate();

    // If it's already exactly the 1st at midnight, keep it; otherwise advance.
    const nextFirst = (d === 1 && min.getUTCHours() === 0 && min.getUTCMinutes() === 0 && min.getUTCSeconds() === 0)
        ? new Date(Date.UTC(y, m, 1, 0, 0, 0))
        : new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

    return Math.floor(nextFirst.getTime() / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail({ to, name, tier, checkoutUrl, trialEnd }) {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPass) {
        console.warn('Email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set. Checkout URL:', checkoutUrl);
        return;
    }

    const nodemailer = require('nodemailer');
    const transport  = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass }
    });

    const tierLabel    = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Service';
    const firstName    = (name || '').split(' ')[0] || name || 'there';
    const trialEndStr  = new Date(trialEnd * 1000).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });

    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <img src="https://thebusiness-lab.com/logo-dark.png" alt="The Business Lab" style="height:36px;margin-bottom:24px" onerror="this.style.display='none'">
  <h1 style="font-size:22px;font-weight:700;color:#0f172a;margin:0 0 6px">Welcome, ${escHtml(firstName)}!</h1>
  <p style="color:#64748b;font-size:14px;margin:0 0 28px">Your <strong>${escHtml(tierLabel)} Plan</strong> agreement has been signed — you're almost set.</p>

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:28px">
    <p style="margin:0 0 8px;font-size:14px;font-weight:600">One step remaining: add a payment method</p>
    <p style="margin:0;font-size:13px;color:#475569">Your 14-day trial runs until <strong>${trialEndStr}</strong>. You won't be charged until then, but we need a card or bank account on file before the trial ends.</p>
  </div>

  <a href="${checkoutUrl}"
     style="display:inline-block;background:#d4af37;color:#0f172a;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;margin-bottom:28px">
    Add Payment Method →
  </a>

  <p style="font-size:13px;color:#64748b;margin-bottom:6px">Button not working? Copy this link:</p>
  <p style="font-size:12px;margin:0 0 32px"><a href="${checkoutUrl}" style="color:#2563eb;word-break:break-all">${checkoutUrl}</a></p>

  <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px">
  <p style="font-size:12px;color:#94a3b8;margin:0">
    Questions? Reply to this email or call 248-775-5058.<br>
    The Business Lab &middot; <a href="https://thebusiness-lab.com" style="color:#94a3b8">thebusiness-lab.com</a>
  </p>
</div>`.trim();

    await transport.sendMail({
        from:    `The Business Lab <${gmailUser}>`,
        to,
        subject: `Action Required: Add your payment method — Business Lab ${tierLabel} Plan`,
        html
    });

    console.log('Email sent to', to);
}

function escHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
