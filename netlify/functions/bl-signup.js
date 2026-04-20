/**
 * Business Lab Signup — Dropbox Sign envelope creation
 *
 * Actions:
 *   create-envelope — build HTML contract and send via Dropbox Sign API
 *
 * Env vars needed: BL_ADMIN_KEY, HELLOSIGN_API_KEY, BL_ADMIN_EMAIL (optional CC)
 */

const https = require('https');
const crypto = require('crypto');

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders(), body: '' };
    }

    const adminKey = process.env.BL_ADMIN_KEY;
    if (!adminKey) return respond(500, { error: 'Server misconfigured: admin key not set' });
    const auth = (event.headers['x-admin-key'] || '').trim();
    if (!auth || auth !== adminKey) return respond(401, { error: 'Invalid admin key', auth_failed: true });

    const hsKey = process.env.HELLOSIGN_API_KEY;
    if (!hsKey) return respond(500, { error: 'HELLOSIGN_API_KEY not configured. Add it in Netlify env vars.' });

    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return respond(400, { error: 'Invalid JSON' }); }

    const { action } = body;

    try {
        switch (action) {

            case 'create-envelope': {
                if (!body.name)  return respond(400, { error: 'name required' });
                if (!body.email) return respond(400, { error: 'email required' });
                if (!body.tier)  return respond(400, { error: 'tier required' });
                if (!body.stripePriceId) return respond(400, { error: 'stripePriceId required' });

                const contractHtml = buildContractHtml(body);
                const result = await sendToDropboxSign(hsKey, body, contractHtml);
                const sr = result.signature_request || {};
                return respond(200, {
                    success: true,
                    signatureRequestId: sr.signature_request_id,
                    signingUrl: sr.signing_url,
                    detailsUrl: sr.details_url
                });
            }

            // ─── LIST ENVELOPES ───
            case 'list-envelopes': {
                const page     = parseInt(body.page || 1);
                const pageSize = parseInt(body.pageSize || 50);
                const raw      = await dsGet(hsKey, `/v3/signature_request/list?page=${page}&page_size=${pageSize}`);
                const envelopes = (raw.signature_requests || []).map(sr => {
                    const signer  = (sr.signatures || [])[0] || {};
                    const status  = sr.is_complete ? 'signed'
                        : sr.is_declined          ? 'declined'
                        : sr.has_error            ? 'error'
                        : 'pending';
                    return {
                        id:          sr.signature_request_id,
                        title:       sr.title || sr.original_title || '',
                        clientName:  signer.signer_name           || '',
                        clientEmail: signer.signer_email_address  || '',
                        signerStatus: signer.status_code          || '',
                        status,
                        sentAt:      sr.created_at  || null,
                        signedAt:    signer.signed_at || null,
                        testMode:    sr.test_mode    || false,
                        metadata:    sr.metadata     || {}
                    };
                });
                const info = raw.list_info || {};
                return respond(200, { success: true, envelopes, listInfo: info });
            }

            // ─── GET ENVELOPE PDF URL ───
            case 'get-envelope-pdf': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                const raw = await dsGet(hsKey, `/v3/signature_request/files/${body.signatureRequestId}?file_type=pdf&get_url=1`);
                return respond(200, { success: true, fileUrl: raw.file_url, expiresAt: raw.expires_at });
            }

            // ─── RESEND ENVELOPE ───
            case 'resend-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                if (!body.email)              return respond(400, { error: 'email required' });
                await dsPost(hsKey, `/v3/signature_request/remind/${body.signatureRequestId}`, { email_address: body.email });
                return respond(200, { success: true });
            }

            default:
                return respond(400, { error: 'Unknown action: ' + action });
        }
    } catch (err) {
        console.error('Signup error:', err.message);
        return respond(500, { error: err.message });
    }
};

// ─── Contract HTML ───────────────────────────────────────────────────────────

function buildContractHtml(data) {
    const { name, email, company, tier, cadence, startDate, monthlyAmount, annualAmount, addons = [], notes = '' } = data;
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const isAnnual = cadence === 'annual';

    const addonRows = addons.length
        ? addons.map(a => `<tr><td>${escHtml(a.name)}</td><td>$${fmtAmount(a.amount)}/${a.interval || 'mo'}</td></tr>`).join('')
        : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>The Business Lab — Service Agreement</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; max-width: 740px; margin: 40px auto; padding: 0 28px; line-height: 1.65; }
  h1 { font-size: 21px; color: #0f172a; border-bottom: 3px solid #d4af37; padding-bottom: 10px; margin-bottom: 22px; }
  h2 { font-size: 14px; color: #0f172a; font-weight: 700; margin-top: 26px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  td, th { border: 1px solid #ddd; padding: 8px 12px; font-size: 13px; text-align: left; }
  th { background: #f8fafc; font-weight: 700; width: 40%; }
  p { margin: 6px 0 10px; }
  .sig-block { margin-top: 48px; page-break-inside: avoid; }
</style>
</head>
<body>

<h1>The Business Lab — Service Agreement</h1>

<h2>Client Information</h2>
<table>
  <tr><th>Client Name</th><td>${escHtml(name)}</td></tr>
  <tr><th>Company</th><td>${escHtml(company || '—')}</td></tr>
  <tr><th>Email</th><td>${escHtml(email)}</td></tr>
</table>

<h2>Service Details</h2>
<table>
  <tr><th>Service Tier</th><td>${escHtml(tierLabel)}</td></tr>
  <tr><th>Billing Cadence</th><td>${isAnnual ? 'Annual (12-month commitment, billed upfront)' : 'Monthly'}</td></tr>
  <tr><th>Monthly Rate</th><td>$${fmtAmount(monthlyAmount)}/month</td></tr>
  ${isAnnual ? `<tr><th>Annual Total</th><td><strong>$${fmtAmount(annualAmount)}/year</strong></td></tr>` : ''}
  <tr><th>Start Date</th><td>${escHtml(startDate || '—')}</td></tr>
</table>

${addonRows ? `<h2>Add-Ons</h2>
<table>
  <tr><th>Description</th><th>Price</th></tr>
  ${addonRows}
</table>` : ''}

<h2>Terms &amp; Conditions</h2>
<p>This Service Agreement ("Agreement") is entered into as of the Start Date above between <strong>The Business Lab</strong> ("Provider") and the client identified above ("Client").</p>

<p><strong>Scope of Services.</strong> Provider agrees to deliver the ${escHtml(tierLabel)} tier services as described in the current service offering at the time of signing, including all features and support levels associated with this tier.</p>

<p><strong>Payment Terms.</strong> Client agrees to pay the fees described above. ${isAnnual ? 'Annual agreements are invoiced upfront and non-refundable once the service period begins.' : 'Monthly fees are due at the beginning of each billing cycle.'} All prices are in USD and subject to applicable taxes.</p>

<p><strong>12-Month Commitment.</strong> This agreement represents a minimum 12-month commitment beginning on the Start Date. Early termination may result in the remaining balance of the annual commitment becoming immediately due.</p>

<p><strong>Renewal.</strong> Unless either party provides written notice of non-renewal at least 30 days before the end of the commitment period, this Agreement will automatically renew on a month-to-month basis at the then-current monthly rate.</p>

<p><strong>Confidentiality.</strong> Both parties agree to maintain the confidentiality of proprietary information, trade secrets, and sensitive business data shared in connection with this Agreement.</p>

<p><strong>Limitation of Liability.</strong> Provider's liability under this Agreement shall not exceed the fees paid in the three (3) months preceding the claim. Provider is not liable for indirect, incidental, or consequential damages.</p>

<p><strong>Governing Law.</strong> This Agreement is governed by the laws of the State of Michigan, without regard to conflict of law principles.</p>

${notes ? `<h2>Additional Notes</h2><p>${escHtml(notes)}</p>` : ''}

<div class="sig-block">
<h2>Signatures</h2>
<p>By signing below, Client agrees to be bound by all terms of this Agreement.</p>
<br>
<p><strong>Client Signature:</strong><br><br>
[sig|req|signer1]<br><br>
[date|req|signer1]<br>
<span style="font-size:12px;color:#555">${escHtml(name)}, ${escHtml(company || '')}</span>
</p>
</div>

</body>
</html>`;
}

// ─── Dropbox Sign API ─────────────────────────────────────────────────────────

async function sendToDropboxSign(apiKey, data, contractHtml) {
    const boundary = 'BL' + crypto.randomBytes(16).toString('hex');
    const contractBuf = Buffer.from(contractHtml, 'utf8');
    const tierLabel = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
    const firstName = (data.name || '').split(' ')[0] || data.name;

    const parts = [];

    const addField = (name, value) => {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`
        ));
    };

    // Signer
    addField('signers[0][name]', data.name);
    addField('signers[0][email_address]', data.email);
    addField('signers[0][order]', '0');

    // Envelope metadata
    addField('title', `The Business Lab ${tierLabel} Service Agreement`);
    addField('subject', `Your Business Lab Service Agreement — ${tierLabel} Tier`);
    addField('message', `Hi ${firstName}, please review and sign your Business Lab service agreement to get started. Questions? Reply to this email.`);

    // Text tags
    addField('use_text_tags', '1');
    addField('hide_text_tags', '1');
    addField('test_mode', '1');

    // Custom metadata (passed to webhook)
    addField('metadata[tier]', data.tier);
    addField('metadata[cadence]', data.cadence || 'annual');
    addField('metadata[stripe_price_id]', data.stripePriceId || '');
    addField('metadata[start_date]', data.startDate || '');
    addField('metadata[company]', data.company || '');
    addField('metadata[addons]', JSON.stringify(data.addons || []));
    if (data.notes) addField('metadata[notes]', data.notes);
    if (data.customerId) addField('metadata[customer_id]', data.customerId);

    // CC admin
    const adminEmail = process.env.BL_ADMIN_EMAIL;
    if (adminEmail) addField('cc_email_addresses[0]', adminEmail);

    // File attachment
    parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file[0]"; filename="service-agreement.html"\r\nContent-Type: text/html\r\n\r\n`),
        contractBuf,
        Buffer.from('\r\n')
    );
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.hellosign.com',
            path: '/v3/signature_request/send',
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (res.statusCode >= 400) {
                        const msg = (parsed.error && parsed.error.error_msg) || parsed.message || `Dropbox Sign error ${res.statusCode}`;
                        reject(new Error(msg));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error('Invalid Dropbox Sign response: ' + raw.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtAmount(cents) {
    if (!cents && cents !== 0) return '0.00';
    return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
}

function respond(code, data) {
    return {
        statusCode: code,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    };
}

// ─── Generic Dropbox Sign helpers ─────────────────────────────────────────────

function dsRequest(apiKey, method, path, body) {
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    const bodyBuf    = body ? Buffer.from(body, 'utf8') : null;
    const headers    = { 'Authorization': authHeader };
    if (bodyBuf) {
        headers['Content-Type']   = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = bodyBuf.length;
    }
    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname: 'api.hellosign.com', path, method, headers },
            (res) => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    if (res.statusCode === 200 && raw === '') { resolve({}); return; }
                    try {
                        const parsed = JSON.parse(raw);
                        if (res.statusCode >= 400) {
                            const msg = (parsed.error && parsed.error.error_msg) || `Dropbox Sign ${res.statusCode}`;
                            reject(new Error(msg));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error('Invalid DS response: ' + raw.slice(0, 200)));
                    }
                });
            }
        );
        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

function dsGet(apiKey, path) {
    return dsRequest(apiKey, 'GET', path, null);
}

function dsPost(apiKey, path, params) {
    const body = Object.entries(params || {})
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return dsRequest(apiKey, 'POST', path, body);
}
