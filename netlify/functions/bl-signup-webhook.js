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

    // ── Parse body ────────────────────────────────────────────────────────────
    // Dropbox Sign POSTs the signature-request JSON in a form field named "json".
    // Content-Type is usually multipart/form-data, but older integrations used
    // application/x-www-form-urlencoded — handle both.
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');

    const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

    let jsonStr = '';
    if (contentType.includes('multipart/form-data')) {
        const m = rawBody.match(/name="json"\r?\n\r?\n([\s\S]*?)\r?\n--/);
        if (m) jsonStr = m[1];
    } else {
        jsonStr = querystring.parse(rawBody).json || '';
    }
    // Last-resort fallback: try both if the first attempt failed
    if (!jsonStr) {
        jsonStr = querystring.parse(rawBody).json || '';
        if (!jsonStr) {
            const m = rawBody.match(/name="json"\r?\n\r?\n([\s\S]*?)\r?\n--/);
            if (m) jsonStr = m[1];
        }
    }

    if (!jsonStr) {
        console.error('Webhook: no json field in body. content-type=', contentType, 'body preview=', rawBody.slice(0, 300));
        return { statusCode: 200, body: DS_ACK };
    }

    // ── Parse payload ─────────────────────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(jsonStr);
    } catch (e) {
        console.error('Webhook: failed to parse JSON:', e.message);
        return { statusCode: 200, body: DS_ACK };
    }

    // ── HMAC verification ─────────────────────────────────────────────────────
    // Dropbox Sign signs each callback by including event.event_hash inside
    // the JSON payload. It is HMAC-SHA256(event_time + event_type, api_key),
    // hex-encoded. No HTTP header is involved.
    const evt          = payload.event || {};
    const receivedHash = (evt.event_hash || '').toLowerCase().trim();
    const expectedHash = crypto
        .createHmac('sha256', hsKey)
        .update(String(evt.event_time || '') + String(evt.event_type || ''))
        .digest('hex');

    if (!receivedHash || receivedHash !== expectedHash) {
        console.error('Webhook HMAC mismatch. Received:', receivedHash, 'Expected:', expectedHash, 'event_type:', evt.event_type);
        // ACK 200 so Dropbox Sign stops retrying; the error is in logs.
        return { statusCode: 200, body: DS_ACK };
    }

    const eventType = evt.event_type;
    console.log('Dropbox Sign event received:', eventType);

    // Respond to the dashboard "Test" button and other non-signature events.
    if (eventType === 'callback_test') {
        return { statusCode: 200, body: DS_ACK };
    }

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

    const sr               = payload.signature_request || {};
    const meta             = sr.metadata || {};
    const signatureRequestId = sr.signature_request_id || '';

    // ── Client info from signer list ──────────────────────────────────────────
    const signers     = sr.signatures || [];
    const signer      = signers[0]    || {};
    const signerEmail = signer.signer_email_address || '';
    const signerName  = signer.signer_name          || '';
    const company     = meta.company || '';
    const clientType  = meta.client_type || 'individual';
    const isCompany   = clientType === 'company';
    const repFirstName = meta.rep_first_name || '';
    const repLastName  = meta.rep_last_name  || '';
    const repEmail     = meta.rep_email      || '';
    const repPhone     = meta.rep_phone      || '';

    // For a company, the Stripe customer is the business itself.
    // The representative (signer) is stored as customer metadata + shipping contact.
    const clientEmail = signerEmail;
    const clientName  = isCompany ? (company || signerName) : signerName;

    const notes       = (meta.notes  || '').slice(0, 500);
    const startDate   = meta.start_date || '';
    const existingCustomerId = meta.customer_id || '';

    // ── Parse items (Phase 3A format) ─────────────────────────────────────────
    let items = [];
    try { items = JSON.parse(meta.items || '[]'); } catch (_) { items = []; }

    // Backwards compat: old-style single tier envelope
    if (items.length === 0 && meta.stripe_price_id) {
        items = [{ priceId: meta.stripe_price_id, category: 'retainer', name: meta.tier || 'Retainer', amount: 0 }];
    }

    const retainers = items.filter(i => i.category === 'retainer');
    const packages  = items.filter(i => i.category === 'package');
    const hourly    = items.filter(i => i.category === 'hourly');

    if (!clientEmail) throw new Error('No client email in webhook payload');
    if (items.length === 0) throw new Error('No items in webhook metadata');

    const collectionMethod = meta.collection_method || 'charge_automatically';
    const paymentMethod    = meta.payment_method    || 'card';
    const pmTypes = paymentMethod === 'ach' ? ['us_bank_account', 'card'] : ['card', 'us_bank_account'];

    console.log(`Processing signup: ${clientName} <${clientEmail}> retainers=${retainers.length} packages=${packages.length} hourly=${hourly.length} sigId=${signatureRequestId}`);

    // ── Idempotency check ─────────────────────────────────────────────────────
    const [existingSubs, existingInvs] = await Promise.all([
        stripe.subscriptions.search({
            query: `metadata['signature_request_id']:'${signatureRequestId}'`,
            limit: 1
        }).catch(() => ({ data: [] })),
        stripe.invoices.search({
            query: `metadata['signature_request_id']:'${signatureRequestId}'`,
            limit: 1
        }).catch(() => ({ data: [] }))
    ]);
    if ((existingSubs.data && existingSubs.data.length) || (existingInvs.data && existingInvs.data.length)) {
        console.log('Duplicate webhook — already processed signatureRequestId:', signatureRequestId);
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
            const customerMeta = {
                company,
                signature_request_id: signatureRequestId,
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

    // ── RETAINERS + PACKAGES → one Stripe subscription (both monthly) ────────
    let checkoutUrl = null;
    const monthlyItems = [...retainers, ...packages];
    if (monthlyItems.length > 0) {
        const trialEnd = computeTrialEnd();
        console.log('Trial end:', new Date(trialEnd * 1000).toISOString());

        const subItems = monthlyItems.filter(i => i.priceId).map(i => ({ price: i.priceId }));
        if (subItems.length === 0) throw new Error('Monthly items missing priceId');

        const subscription = await stripe.subscriptions.create({
            customer:         customerId,
            items:            subItems,
            trial_end:        trialEnd,
            payment_behavior: 'default_incomplete',
            collection_method: collectionMethod,
            payment_settings: {
                save_default_payment_method: 'on_subscription',
                payment_method_types: pmTypes
            },
            metadata: {
                signature_request_id: signatureRequestId,
                notes
            }
        });
        console.log('Subscription created:', subscription.id, 'status:', subscription.status);

        // Checkout session to capture payment method
        const setupOpts = {
            mode:     'setup',
            customer: customerId,
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

    // ── HOURLY → log only (invoiced later per session) ────────────────────────
    if (hourly.length > 0) {
        const hourlyLog = hourly.map(i => `${i.name} x${i.hours || '?'}hrs`).join(', ');
        console.log('Hourly pre-auth logged:', hourlyLog);
    }

    // ── Send email to client ──────────────────────────────────────────────────
    // Greeting uses the signer's first name (for company clients, the representative).
    const greetingName = isCompany
        ? (repFirstName || signerName || clientName)
        : signerName;
    await sendEmail({
        to:                 clientEmail,
        name:               greetingName,
        retainers,
        packages,
        hourly,
        checkoutUrl,
        trialEnd:           monthlyItems.length > 0 ? computeTrialEnd() : null
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

async function sendEmail({ to, name, retainers = [], packages = [], hourly = [], checkoutUrl, trialEnd }) {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPass) {
        console.warn('Email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set. checkoutUrl:', checkoutUrl);
        return;
    }

    const nodemailer = require('nodemailer');
    const transport  = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass }
    });

    const firstName = (name || '').split(' ')[0] || name || 'there';
    const trialEndStr = trialEnd
        ? new Date(trialEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        : null;

    // Build action sections
    let actionBlocks = '';

    if (checkoutUrl && (retainers.length > 0 || packages.length > 0)) {
        const monthlyNames = [...retainers, ...packages].map(r => escHtml(r.name || 'Service')).join(', ');
        actionBlocks += `
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <p style="margin:0 0 6px;font-size:14px;font-weight:600">Step 1 — Add your payment method</p>
    <p style="margin:0 0 12px;font-size:13px;color:#475569">Required for: ${monthlyNames}${trialEndStr ? `. Your trial runs until <strong>${trialEndStr}</strong> — no charge until then.` : '.'}</p>
    <a href="${checkoutUrl}" style="display:inline-block;background:#d4af37;color:#0f172a;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Add Payment Method →</a>
    <p style="font-size:12px;color:#94a3b8;margin:8px 0 0">Can't click? <a href="${checkoutUrl}" style="color:#2563eb;word-break:break-all">${checkoutUrl}</a></p>
  </div>`;
    }

    if (hourly.length > 0 && !checkoutUrl) {
        actionBlocks += `
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px">
    <p style="margin:0 0 6px;font-size:14px;font-weight:600">Hourly Services Pre-Authorization</p>
    <p style="margin:0;font-size:13px;color:#475569">Your pre-authorized hourly services are now active. You'll receive invoices within 15 days of completed sessions. Contact us to schedule your first session.</p>
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
        subject: `Welcome to The Business Lab — Next steps inside`,
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
