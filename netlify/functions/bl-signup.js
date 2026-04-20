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
                const items = body.items || [];
                if (!items.length) return respond(400, { error: 'items required — add at least one retainer, package, or hourly service' });

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
                const envelopes = (raw.signature_requests || [])
                    .map(sr => {
                        const signer  = (sr.signatures || [])[0] || {};
                        const status  = sr.is_complete ? 'signed'
                            : sr.is_declined          ? 'declined'
                            : sr.has_error            ? 'error'
                            : 'pending';
                        return {
                            id:           sr.signature_request_id,
                            title:        sr.title || sr.original_title || '',
                            clientName:   signer.signer_name           || '',
                            clientEmail:  signer.signer_email_address  || '',
                            signerStatus: signer.status_code           || '',
                            status,
                            sentAt:    sr.created_at    || null,
                            signedAt:  signer.signed_at || null,
                            testMode:  sr.test_mode     || false,
                            metadata:  sr.metadata      || {}
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

            // ─── CANCEL ENVELOPE ───
            case 'cancel-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                await dsPost(hsKey, `/v3/signature_request/cancel/${body.signatureRequestId}`, {});
                return respond(200, { success: true });
            }

            // ─── REMOVE ENVELOPE ───
            case 'remove-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                await dsPost(hsKey, `/v3/signature_request/remove/${body.signatureRequestId}`, {});
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
    const {
        clientType = 'individual',
        name, email, company,
        repFirstName = '', repLastName = '', repEmail = '', repPhone = '',
        items = [], collectionMethod, paymentMethod, startDate, notes = ''
    } = data;
    const retainers = items.filter(i => i.category === 'retainer');
    const packages  = items.filter(i => i.category === 'package');
    const hourly    = items.filter(i => i.category === 'hourly');

    const isCompany = clientType === 'company';
    const isAutopay = collectionMethod !== 'send_invoice';
    const isACH     = paymentMethod === 'ach';

    // Scope of Engagement table rows
    let scopeRows = '';
    if (retainers.length) {
        retainers.forEach(i => {
            scopeRows += `<tr><td>${escHtml(i.name)}</td><td>Monthly Retainer</td><td>$${fmtAmount(i.amount)}/mo</td><td>12-month commitment</td></tr>`;
        });
    }
    if (packages.length) {
        packages.forEach(i => {
            scopeRows += `<tr><td>${escHtml(i.name)}</td><td>Monthly Package</td><td>$${fmtAmount(i.amount)}/mo</td><td>Month-to-month</td></tr>`;
        });
    }
    if (hourly.length) {
        hourly.forEach(i => {
            const hrs = i.hours || 0;
            const est = hrs ? '$' + fmtAmount(i.amount * hrs) + ' est.' : 'Per invoice';
            scopeRows += `<tr><td>${escHtml(i.name)}</td><td>Hourly (Pre-Auth)</td><td>$${fmtAmount(i.amount)}/hr${hrs ? ' &times; ' + hrs + ' hrs' : ''}</td><td>${est}</td></tr>`;
        });
    }

    const totalMonthly = retainers.reduce((s, i) => s + i.amount, 0) + packages.reduce((s, i) => s + i.amount, 0);
    const totalHourly  = hourly.reduce((s, i) => s + (i.amount * (i.hours || 0)), 0);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>The Business Lab — Master Services Agreement</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; max-width: 760px; margin: 40px auto; padding: 0 28px; line-height: 1.7; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #d4af37; padding-bottom: 14px; margin-bottom: 24px; }
  .brand { font-size: 18px; font-weight: 700; color: #0f172a; letter-spacing: -0.5px; }
  .brand span { color: #d4af37; }
  .tagline { font-size: 11px; color: #64748b; margin-top: 2px; }
  h1 { font-size: 19px; color: #0f172a; margin: 0 0 4px; }
  h2 { font-size: 13px; color: #0f172a; font-weight: 700; margin-top: 24px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
  td, th { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f8fafc; font-weight: 700; }
  .scope th { background: #0f172a; color: #fff; }
  .scope tr:nth-child(even) td { background: #f8fafc; }
  p { margin: 6px 0 10px; }
  .totals { background: #fefce8; border: 1px solid #fde047; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }
  .totals strong { color: #0f172a; }
  .payment-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }
  .sig-block { margin-top: 48px; page-break-inside: avoid; }
  .sig-block p { margin-bottom: 6px; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="brand">The Business <span>Lab</span></div>
    <div class="tagline">Strategy &middot; Finance &middot; Marketing &middot; Legal &middot; Technology</div>
  </div>
  <div style="text-align:right">
    <h1>Master Services Agreement</h1>
    <div style="font-size:12px;color:#64748b">Effective: ${escHtml(startDate || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}</div>
  </div>
</div>

<h2>About The Business Lab</h2>
<p>The Business Lab is a full-service business advisory firm helping entrepreneurs and growing companies build, scale, and sustain competitive businesses. Our integrated team of strategists, financial advisors, legal professionals, and marketing specialists delivers hands-on guidance — not generic advice. We work alongside our clients as a trusted partner, combining big-picture strategy with on-the-ground execution.</p>

<h2>Client Information</h2>
<table>
  ${isCompany ? `
  <tr><th style="width:35%">Client Type</th><td>Company / Business</td></tr>
  <tr><th>Company Name</th><td>${escHtml(company || name || '—')}</td></tr>
  <tr><th>Authorized Representative</th><td>${escHtml((repFirstName + ' ' + repLastName).trim() || name || '—')}</td></tr>
  <tr><th>Representative Email</th><td>${escHtml(repEmail || email)}</td></tr>
  ${repPhone ? `<tr><th>Representative Phone</th><td>${escHtml(repPhone)}</td></tr>` : ''}
  ` : `
  <tr><th style="width:35%">Client Type</th><td>Individual</td></tr>
  <tr><th>Full Name</th><td>${escHtml(name)}</td></tr>
  ${company ? `<tr><th>Company (if applicable)</th><td>${escHtml(company)}</td></tr>` : ''}
  <tr><th>Email</th><td>${escHtml(email)}</td></tr>
  `}
  <tr><th>Engagement Start Date</th><td>${escHtml(startDate || '—')}</td></tr>
</table>

<h2>Scope of Engagement</h2>
<table class="scope">
  <thead><tr><th>Service</th><th>Type</th><th>Fee</th><th>Terms</th></tr></thead>
  <tbody>${scopeRows}</tbody>
</table>

${(totalMonthly || totalHourly) ? `<div class="totals">
  <strong>Fee Summary:</strong>&nbsp;
  ${totalMonthly ? '<span>Monthly fee: <strong>$' + fmtAmount(totalMonthly) + '/mo</strong></span>' : ''}
  ${totalMonthly && totalHourly ? '&nbsp;&nbsp;&middot;&nbsp;&nbsp;' : ''}
  ${totalHourly ? '<span>Hourly pre-auth est.: <strong>$' + fmtAmount(totalHourly) + '</strong></span>' : ''}
</div>` : ''}

<div class="payment-box">
  <strong>Payment Method:</strong> ${isAutopay ? ('Autopay — ' + (isACH ? 'ACH bank transfer' : 'credit/debit card') + ' charged automatically') : 'Invoice — Net-15 invoices sent at each billing event'}.
  ${isAutopay ? ' Client authorizes The Business Lab to charge the payment method on file according to the schedule above.' : ''}
</div>

<h2>Terms &amp; Conditions</h2>
<p>This Master Services Agreement ("Agreement") is entered into as of the Effective Date above between <strong>The Business Lab</strong> ("Provider") and the client identified above ("Client").</p>

<p><strong>1. Retainer Services.</strong> Monthly retainer fees cover the agreed scope of ongoing advisory and execution services. Retainer hours and deliverables do not roll over month to month. The retainer engagement represents a minimum 12-month commitment. Early termination before 12 months requires 60 days written notice and payment of the lesser of (i) the remaining balance through month 12 or (ii) three months of retainer fees.</p>

<p><strong>2. Package Services.</strong> Monthly package fees are billed on the same monthly cycle as retainers and cover the package's defined scope of deliverables for that month. Packages are month-to-month and may be canceled by either party with 30 days written notice. Unused deliverables within a given month do not roll over.</p>

<p><strong>3. Hourly Services.</strong> Hourly services are billed against the pre-authorized hour blocks identified above. Provider will invoice within 15 days of completing hourly work. Unused pre-authorized hours expire 12 months from the Effective Date. Additional hours beyond the pre-authorized block require a written amendment.</p>

<p><strong>4. Auto-Renewal.</strong> Retainer agreements automatically renew for successive 12-month terms unless either party provides written notice of non-renewal at least 60 days before the end of the current term.</p>

<p><strong>5. Backup Payment Method.</strong> Client agrees to maintain a valid backup payment method on file at all times during the engagement. Provider reserves the right to charge the backup method if the primary payment method fails and is not updated within 5 business days of notice.</p>

<p><strong>6. Late Payments.</strong> Invoices not paid within the due date accrue interest at 1.5% per month. Provider may suspend services for accounts more than 30 days past due.</p>

<p><strong>7. Confidentiality.</strong> Both parties agree to maintain the confidentiality of proprietary information, trade secrets, and sensitive business data shared in connection with this Agreement. This obligation survives termination of the Agreement for 3 years.</p>

<p><strong>8. Limitation of Liability.</strong> Provider's total liability under this Agreement shall not exceed the fees paid in the three (3) months preceding the claim. Provider is not liable for indirect, incidental, special, or consequential damages, including lost profits.</p>

<p><strong>9. Governing Law &amp; Disputes.</strong> This Agreement is governed by the laws of the State of Michigan, without regard to conflict of law principles. The parties agree to attempt good-faith mediation before initiating litigation.</p>

<p><strong>10. Entire Agreement.</strong> This Agreement constitutes the entire agreement between the parties regarding the engagement described herein and supersedes all prior negotiations, representations, or agreements.</p>

${notes ? `<h2>Special Terms / Notes</h2><p>${escHtml(notes)}</p>` : ''}

<div class="sig-block">
<h2>Signatures</h2>
<p>By signing below, ${isCompany ? 'the authorized Representative below binds the Company named above to this Agreement and' : 'Client'} acknowledges that they have read and understood this Agreement and agree to be bound by its terms.</p>
<br>
<table style="border:none">
  <tr>
    <td style="border:none;width:50%;padding:8px 0;vertical-align:top">
      <p><strong>${isCompany ? 'Authorized Representative' : 'Client'}</strong></p>
      <p>Signature:&nbsp; [sig|req|signer1]</p>
      <p>Date:&nbsp; [date|req|signer1]</p>
      <p style="font-size:11px;color:#555">${isCompany
          ? escHtml(((repFirstName + ' ' + repLastName).trim() || name)) + (company ? ', on behalf of ' + escHtml(company) : '')
          : escHtml(name) + (company ? ', ' + escHtml(company) : '')}</p>
    </td>
    <td style="border:none;width:50%;padding:8px 0 8px 24px;vertical-align:top">
      <p><strong>The Business Lab</strong></p>
      <p style="font-size:12px;color:#555">Dr. Silvio Cozzetto, CEO</p>
      <p style="font-size:12px;color:#555">248-775-5058 &nbsp;|&nbsp; thebusiness-lab.com</p>
    </td>
  </tr>
</table>
</div>

</body>
</html>`;
}

// ─── Dropbox Sign API ─────────────────────────────────────────────────────────

async function sendToDropboxSign(apiKey, data, contractHtml) {
    const boundary = 'BL' + crypto.randomBytes(16).toString('hex');
    const contractBuf = Buffer.from(contractHtml, 'utf8');

    const isCompany   = data.clientType === 'company';
    const signerName  = isCompany
        ? ((data.repFirstName || '') + ' ' + (data.repLastName || '')).trim() || data.name
        : data.name;
    const signerEmail = isCompany ? (data.repEmail || data.email) : data.email;
    const firstName   = (signerName || '').split(' ')[0] || signerName;

    const items = data.items || [];
    const retainerCount = items.filter(i => i.category === 'retainer').length;
    const packageCount  = items.filter(i => i.category === 'package').length;
    const hourlyCount   = items.filter(i => i.category === 'hourly').length;
    const scopeSummary  = [
        retainerCount ? retainerCount + ' retainer' + (retainerCount > 1 ? 's' : '') : '',
        packageCount  ? packageCount  + ' package'  + (packageCount  > 1 ? 's' : '') : '',
        hourlyCount   ? hourlyCount   + ' hourly service' + (hourlyCount > 1 ? 's' : '') : '',
    ].filter(Boolean).join(', ');

    const parts = [];

    const addField = (name, value) => {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`
        ));
    };

    // Signer (representative's name/email for company clients)
    addField('signers[0][name]', signerName);
    addField('signers[0][email_address]', signerEmail);
    addField('signers[0][order]', '0');

    // Envelope metadata
    addField('title', `The Business Lab — Master Services Agreement`);
    addField('subject', `Your Business Lab Master Services Agreement — Action Required`);
    addField('message', `Hi ${firstName}, please review and sign your Business Lab Master Services Agreement (${scopeSummary}). Questions? Call 248-775-5058 or reply to this email.`);

    // Text tags
    addField('use_text_tags', '1');
    addField('hide_text_tags', '1');
    addField('test_mode', '1');

    // Custom metadata (passed to webhook)
    addField('metadata[source]', 'business-lab-admin');
    addField('metadata[items]', JSON.stringify(items));
    addField('metadata[collection_method]', data.collectionMethod || 'charge_automatically');
    addField('metadata[payment_method]', data.paymentMethod || 'card');
    addField('metadata[start_date]', data.startDate || '');
    addField('metadata[company]', data.company || '');
    addField('metadata[client_type]', isCompany ? 'company' : 'individual');
    // Pack rep fields into a single JSON blob to stay under Dropbox Sign's 10-key metadata cap.
    if (isCompany) {
        const rep = {
            first: data.repFirstName || '',
            last:  data.repLastName  || '',
            email: data.repEmail     || '',
            phone: data.repPhone     || ''
        };
        addField('metadata[rep]', JSON.stringify(rep));
    }
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
                    if ((res.statusCode === 200 || res.statusCode === 204) && raw === '') { resolve({}); return; }
                    try {
                        const parsed = JSON.parse(raw);
                        if (res.statusCode >= 400) {
                            const msg = (parsed.error && parsed.error.error_msg) || `Dropbox Sign ${res.statusCode}`;
                            console.error(`DS error ${res.statusCode} ${method} ${path}:`, raw.slice(0, 500));
                            reject(new Error(msg));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        console.error(`DS non-JSON ${res.statusCode} ${method} ${path}:`, raw.slice(0, 200));
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
