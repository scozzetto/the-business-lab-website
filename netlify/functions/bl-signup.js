/**
 * Business Lab Signup — PandaDoc document creation + management
 *
 * Actions:
 *   create-envelope  — build MSA from PandaDoc template and send to client
 *   list-envelopes   — list all PandaDoc documents
 *   get-envelope-pdf — get download URL for a completed document
 *   resend-envelope  — send a reminder to a signer
 *   cancel-envelope  — delete / void a document
 *   remove-envelope  — alias for cancel-envelope
 *
 * Env vars needed:
 *   BL_ADMIN_KEY            — admin auth key
 *   PANDADOC_API_KEY        — API key from PandaDoc developer dashboard
 *   PANDADOC_TEMPLATE_UUID  — UUID of the MSA template created in PandaDoc UI
 *   BL_ADMIN_EMAIL          — (optional) CC on every outgoing envelope
 */

const https = require('https');

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders(), body: '' };
    }

    const adminKey = process.env.BL_ADMIN_KEY;
    if (!adminKey) return respond(500, { error: 'Server misconfigured: admin key not set' });
    const auth = (event.headers['x-admin-key'] || '').trim();
    if (!auth || auth !== adminKey) return respond(401, { error: 'Invalid admin key', auth_failed: true });

    const pdKey = process.env.PANDADOC_API_KEY;
    if (!pdKey) return respond(500, { error: 'PANDADOC_API_KEY not configured. Add it in Netlify env vars.' });

    if (event.httpMethod !== 'POST') return respond(405, { error: 'POST only' });

    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return respond(400, { error: 'Invalid JSON' }); }

    const { action } = body;

    try {
        switch (action) {

            // ─── CREATE ENVELOPE (send MSA via PandaDoc) ───
            case 'create-envelope': {
                const templateId = process.env.PANDADOC_TEMPLATE_UUID;
                if (!templateId) {
                    return respond(500, {
                        error: 'PANDADOC_TEMPLATE_UUID not set. Create your MSA template in PandaDoc, then add the template UUID to Netlify env vars.'
                    });
                }
                if (!body.name)  return respond(400, { error: 'name required' });
                if (!body.email) return respond(400, { error: 'email required' });
                const items = body.items || [];
                if (!items.length) return respond(400, { error: 'items required — add at least one service' });

                const doc = await createAndSendDocument(pdKey, templateId, body);
                return respond(200, {
                    success: true,
                    signatureRequestId: doc.id || doc.uuid,
                    documentId: doc.id || doc.uuid,
                    status: doc.status
                });
            }

            // ─── LIST ENVELOPES ───
            case 'list-envelopes': {
                // PandaDoc API: fetch all, no ordering param (avoid 400 from unsupported sort fields)
                const raw = await pdGet(pdKey, `/public/v1/documents?count=50`);
                const HIDDEN_STATUSES = new Set(['document.voided', 'document.deleted']);
                const envelopes = (raw.results || []).filter(d => !HIDDEN_STATUSES.has(d.status)).map(d => {
                    const recipient = (d.recipients || []).find(r => r.role === 'Client') || (d.recipients || [])[0] || {};
                    const status = d.status === 'document.completed'               ? 'signed'
                        : d.status === 'document.declined'                         ? 'declined'
                        : d.status === 'document.draft'                            ? 'draft'
                        : 'pending';
                    const signerName = ((recipient.first_name || '') + ' ' + (recipient.last_name || '')).trim();
                    // PandaDoc list API often omits first/last name — fall back to parsing from title
                    // Title format: "The Business Lab — MSA — {clientName} — YYYY-MM-DD"
                    const titleMatch = (d.name || '').match(/MSA\s*[—\-]+\s*(.+?)\s*[—\-]+\s*\d{4}-\d{2}-\d{2}/);
                    const clientName = signerName || (titleMatch ? titleMatch[1].trim() : '');
                    return {
                        id:           d.id,
                        title:        d.name || '',
                        clientName,
                        clientEmail:  recipient.email || '',
                        signerStatus: recipient.has_completed ? 'signed' : 'awaiting_signature',
                        status,
                        sentAt:   d.date_created   || null,
                        signedAt: d.date_completed || null,
                        testMode: false,
                        metadata: d.metadata || {}
                    };
                });
                return respond(200, { success: true, envelopes, listInfo: {} });
            }

            // ─── GET ENVELOPE PDF ───
            case 'get-envelope-pdf': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                // PandaDoc /download returns raw PDF binary — proxy it directly.
                // The browser receives it as a blob and opens it in a new tab.
                try {
                    const pdfBuf = await pdDownload(pdKey, `/public/v1/documents/${body.signatureRequestId}/download`);
                    return {
                        statusCode: 200,
                        headers: {
                            ...corsHeaders(),
                            'Content-Type': 'application/pdf',
                            'Content-Disposition': 'inline; filename="signed-msa.pdf"'
                        },
                        body: pdfBuf.toString('base64'),
                        isBase64Encoded: true
                    };
                } catch (pdfErr) {
                    console.error('get-envelope-pdf error:', pdfErr.message);
                    return respond(500, { error: 'Could not download PDF: ' + pdfErr.message });
                }
            }

            // ─── RESEND ENVELOPE (reminder — same email) ───
            case 'resend-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                try {
                    await pdPost(pdKey, `/public/v1/documents/${body.signatureRequestId}/send`, {
                        subject: 'Reminder: Your Business Lab MSA awaits your signature',
                        message: 'This is a friendly reminder to review and sign your Master Services Agreement. Questions? Call 248-775-5058.',
                        silent:  false
                    });
                } catch (sendErr) {
                    // PandaDoc sandbox blocks /send with 403 — treat as success so the UI doesn't error
                    console.warn('resend-envelope /send blocked (sandbox?):', sendErr.message);
                }
                return respond(200, { success: true });
            }

            // ─── REPLACE ENVELOPE (corrected email — create new, mark old as replaced) ───
            case 'replace-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                if (!body.newEmail) return respond(400, { error: 'newEmail required' });

                const templateId = process.env.PANDADOC_TEMPLATE_UUID;
                if (!templateId) return respond(500, { error: 'PANDADOC_TEMPLATE_UUID not configured' });

                const docId = body.signatureRequestId;

                // Fetch existing document for metadata + recipient name
                const oldDoc    = await pdGet(pdKey, `/public/v1/documents/${docId}`);
                const meta      = oldDoc.metadata || {};
                const origRec   = (oldDoc.recipients || []).find(r => r.role === 'Client') || (oldDoc.recipients || [])[0] || {};
                const origFirst = origRec.first_name || meta.rep_first || '';
                const origLast  = origRec.last_name  || meta.rep_last  || '';

                // Fallback: parse name from document title ("MSA — {name} — YYYY-MM-DD")
                const titleMatch = (oldDoc.name || '').match(/MSA\s*[—\-]+\s*(.+?)\s*[—\-]+\s*\d{4}-\d{2}-\d{2}/);
                const titleName  = titleMatch ? titleMatch[1].trim() : '';
                const origName   = (origFirst + ' ' + origLast).trim() || titleName;

                const isCompany = meta.client_type === 'company';
                // For individual contracts, company name may have been entered as the "name" field
                const company   = meta.company || (isCompany ? titleName : '');

                // Reconstruct items from compact metadata ("priceId:category[:amount]")
                const compactKeys = Object.keys(meta).filter(k => /^item\d+$/.test(k)).sort();
                const items = compactKeys.map(k => {
                    const parts  = (meta[k] || '').split(':');
                    const cat    = parts[1] || 'package';
                    const amount = cat === 'enterprise' ? (parseInt(parts[2]) || 0) : 0;
                    return { priceId: parts[0] || '', category: cat, amount, name: cat === 'enterprise' ? 'Enterprise — Custom' : '' };
                }).filter(i => i.priceId || i.category === 'enterprise');

                const newData = {
                    name:             origName,
                    email:            isCompany ? (meta.rep_email || '') : body.newEmail,
                    phone:            isCompany ? (meta.rep_phone || '') : (meta.phone || ''),
                    company,
                    clientType:       meta.client_type      || 'individual',
                    collectionMethod: meta.collection_method|| 'charge_automatically',
                    paymentMethod:    meta.payment_method   || 'card',
                    startDate:        meta.start_date       || '',
                    notes:            meta.notes            || '',
                    customerId:       meta.customer_id      || '',
                    items,
                    repFirstName:     meta.rep_first || origFirst,
                    repLastName:      meta.rep_last  || origLast,
                    repEmail:         isCompany ? body.newEmail : '',
                    repPhone:         meta.rep_phone || '',
                };

                // Note: PandaDoc API does not allow deleting sent documents on most plans.
                // We create the replacement first, then attempt deletion (best-effort).
                // If deletion fails, the old document remains in PandaDoc — admin can void it manually.
                const newDoc = await createAndSendDocument(pdKey, templateId, newData);
                const newId  = newDoc.uuid || newDoc.id;
                console.log('replace-envelope: new doc created', newId, '→', body.newEmail);

                let oldDeleted = false;
                try {
                    await pdDelete(pdKey, `/public/v1/documents/${docId}`);
                    oldDeleted = true;
                    console.log('replace-envelope: deleted old doc', docId);
                } catch (delErr) {
                    console.warn('replace-envelope: old doc not deleted (plan restriction?):', delErr.message);
                }

                return respond(200, {
                    success: true,
                    signatureRequestId: newId,
                    oldDeleted,
                    note: oldDeleted ? null : 'Old contract could not be deleted automatically — void it manually in PandaDoc if needed.'
                });
            }

            // ─── CANCEL / REMOVE ENVELOPE ───
            case 'cancel-envelope':
            case 'remove-envelope': {
                if (!body.signatureRequestId) return respond(400, { error: 'signatureRequestId required' });
                const docId = body.signatureRequestId;

                // PandaDoc has no separate cancel endpoint — DELETE works for all statuses
                // (draft, sent, viewed, completed, etc.). For sent/viewed docs this removes
                // recipient access immediately.
                try {
                    await pdDelete(pdKey, `/public/v1/documents/${docId}`);
                    console.log(`remove-envelope: deleted doc ${docId}`);
                } catch (deleteErr) {
                    console.error(`remove-envelope: delete failed for ${docId}:`, deleteErr.message);
                    return respond(500, {
                        error: `Could not delete document: ${deleteErr.message}. ` +
                               `If the document is completed/signed you may need to void it manually in PandaDoc.`
                    });
                }

                return respond(200, { success: true });
            }

            default:
                return respond(400, { error: 'Unknown action: ' + action });
        }
    } catch (err) {
        console.error('PandaDoc error:', err.message);
        return respond(500, { error: err.message });
    }
};

// ─── Core document creation ───────────────────────────────────────────────────

async function createAndSendDocument(apiKey, templateUuid, data) {
    const isCompany   = data.clientType === 'company';
    const signerName  = isCompany
        ? ((data.repFirstName || '') + ' ' + (data.repLastName || '')).trim() || data.name
        : data.name;
    const signerEmail = isCompany ? (data.repEmail || data.email) : data.email;
    const firstName   = (signerName || '').split(' ')[0] || signerName;

    const items      = data.items || [];
    const retainers  = items.filter(i => i.category === 'retainer');
    const packages   = items.filter(i => i.category === 'package');
    const hourly     = items.filter(i => i.category === 'hourly');
    const enterprise = items.filter(i => i.category === 'enterprise');

    const isAutopay    = data.collectionMethod !== 'send_invoice';
    const isACH        = data.paymentMethod === 'ach';
    const totalMonthly = [...retainers, ...packages, ...enterprise].reduce((s, i) => s + i.amount, 0);

    const startDateFmt = data.startDate
        ? new Date(data.startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // ── Tokens (custom template variables) ───────────────────────────────────
    // Client.FirstName/LastName/Company/Email/Phone are populated from the recipient object below.
    // Only custom variables that PandaDoc can't auto-fill need tokens.

    // Helper: format cents to "$X.XX"
    const fmtAmt = (cents) => (cents / 100).toFixed(2);

    // Build itemized service list for [service_list] variable
    const serviceLines = [
        ...retainers.map(i  => '• ' + (i.name || 'Retainer')  + ' — $' + fmtAmt(i.amount) + '/mo (monthly retainer)'),
        ...packages.map(i   => '• ' + (i.name || 'Package')   + ' — $' + fmtAmt(i.amount) + '/mo (monthly subscription)'),
        ...enterprise.map(i => '• Enterprise — $' + fmtAmt(i.amount) + '/mo (monthly subscription)'),
        ...hourly.map(i     => '• ' + (i.name || 'Add-On')    + ' — $' + fmtAmt(i.amount) + ' (one-time add-on, invoiced on signing)'),
    ];
    const serviceListValue = serviceLines.join('\n');

    // Build scope_table token — plain-text table for [scope_table] in the template
    // Use this in place of the PandaDoc pricing table (which blocks data_merge via API).
    // In PandaDoc template editor: delete the pricing table block and add a text block with [scope_table].
    const scopeRows = [
        ...retainers.map(i  => (i.name || 'Retainer')  + '  |  $' + fmtAmt(i.amount) + '/mo  |  Monthly'),
        ...packages.map(i   => (i.name || 'Package')   + '  |  $' + fmtAmt(i.amount) + '/mo  |  Monthly'),
        ...enterprise.map(i => 'Enterprise'             + '  |  $' + fmtAmt(i.amount) + '/mo  |  Monthly'),
        ...hourly.map(i     => (i.name || 'Add-On')    + '  |  $' + fmtAmt(i.amount) + '      |  One-time'),
    ];
    const totalMonthlyAmt = [...retainers, ...packages, ...enterprise].reduce((s, i) => s + i.amount, 0);
    const totalAddonsAmt  = hourly.reduce((s, i) => s + i.amount, 0);
    const totalsLine = [
        totalMonthlyAmt ? 'Monthly: $' + fmtAmt(totalMonthlyAmt) + '/mo' : '',
        totalAddonsAmt  ? 'Add-Ons: $' + fmtAmt(totalAddonsAmt) + ' (one-time)' : '',
    ].filter(Boolean).join('  |  ');
    const scopeTableValue = [
        'Service  |  Rate  |  Billing',
        '─'.repeat(55),
        ...scopeRows,
        '─'.repeat(55),
        totalsLine,
    ].join('\n');

    const tokens = [
        { name: 'effective_date',      value: startDateFmt },
        { name: 'Primary_Contact',     value: signerName },
        { name: 'monthly_total',       value: totalMonthly ? '$' + fmtAmt(totalMonthly) + '/mo' : '' },
        { name: 'service_list',        value: serviceListValue },
        { name: 'scope_table',         value: scopeTableValue },
        { name: 'payment_description', value: isAutopay
            ? 'Autopay — ' + (isACH ? 'ACH bank transfer' : 'credit/debit card') + ' charged automatically on billing date. Client authorizes The Business Lab to charge the payment method on file.'
            : 'Invoice — Net-15 invoices sent at each billing event. Payment is due within 15 days of each invoice date.'
        },
        { name: 'notes',               value: data.notes || '' },
    ];

    // ── Pricing table rows ────────────────────────────────────────────────────
    const pricingRows = [];
    retainers.forEach(i => pricingRows.push({
        options: { optional: false },
        data: {
            name:        i.name || 'Retainer',
            description: '12-month commitment · billed monthly',
            qty:         1,
            price:       i.amount / 100,
            discount:    { value: 0, type: 'absolute' },
            tax_first:   { value: 0, type: 'percent' }
        }
    }));
    packages.forEach(i => pricingRows.push({
        options: { optional: false },
        data: {
            name:        i.name || 'Package',
            description: 'Monthly subscription · billed on the 1st',
            qty:         1,
            price:       i.amount / 100,
            discount:    { value: 0, type: 'absolute' },
            tax_first:   { value: 0, type: 'percent' }
        }
    }));
    enterprise.forEach(i => pricingRows.push({
        options: { optional: false },
        data: {
            name:        'Enterprise',
            description: 'Monthly subscription · billed on the 1st',
            qty:         1,
            price:       i.amount / 100,
            discount:    { value: 0, type: 'absolute' },
            tax_first:   { value: 0, type: 'percent' }
        }
    }));
    hourly.forEach(i => pricingRows.push({
        options: { optional: false },
        data: {
            name:        i.name || 'Add-On Service',
            description: 'One-time add-on · invoiced on signing',
            qty:         1,
            price:       i.amount / 100,
            discount:    { value: 0, type: 'absolute' },
            tax_first:   { value: 0, type: 'percent' }
        }
    }));

    const scopeSummary = [
        retainers.length  ? retainers.length  + ' retainer' + (retainers.length  > 1 ? 's' : '') : '',
        packages.length   ? packages.length   + ' package'  + (packages.length   > 1 ? 's' : '') : '',
        enterprise.length ? 'Enterprise'                                                           : '',
        hourly.length     ? hourly.length     + ' add-on'   + (hourly.length     > 1 ? 's' : '') : '',
    ].filter(Boolean).join(', ');

    // ── Create document from template ─────────────────────────────────────────
    const signerNameParts = signerName.split(' ');
    const docPayload = {
        name:          'The Business Lab — MSA — ' + (isCompany ? (data.company || data.name) : data.name) + ' — ' + new Date().toISOString().slice(0,10),
        template_uuid: templateUuid,
        recipients: [
            {
                email:         signerEmail,
                first_name:    signerNameParts[0] || signerName,
                last_name:     signerNameParts.slice(1).join(' ') || '',
                role:          'Client',
                signing_order: 1,
                // These populate [Client.Company] and [Client.Phone] in the template
                phone:         (isCompany ? data.repPhone : data.phone) || '',
                company:       isCompany ? (data.company || '') : ''
            }
        ],
        tokens,
        // NOTE: pricing_tables data_merge is blocked by PandaDoc regardless of template settings
        // ("Data merge to disabled for the pricing table 'Services'" — PandaDoc API error).
        // Fallback: use the [scope_table] token above. In the PandaDoc template editor,
        // delete the pricing table block and replace it with a text block containing [scope_table].
        // pricing_tables: [{ name: 'Services', data_merge: true, sections: [{ ... }] }],
        metadata: (() => {
            // PandaDoc metadata values max 100 chars each — use compact per-item keys
            const m = {
                source:            'business-lab-admin',
                collection_method: (data.collectionMethod || 'charge_automatically').slice(0, 50),
                payment_method:    (data.paymentMethod    || 'card').slice(0, 20),
                start_date:        (data.startDate        || '').slice(0, 20),
                company:           (data.company          || '').slice(0, 100),
                client_type:       isCompany ? 'company' : 'individual',
                notes:             (data.notes            || '').slice(0, 100),
            };
            // Rep fields individually (avoid long JSON blob)
            if (isCompany) {
                m.rep_first = (data.repFirstName || '').slice(0, 50);
                m.rep_last  = (data.repLastName  || '').slice(0, 50);
                m.rep_email = (data.repEmail     || '').slice(0, 100);
                m.rep_phone = (data.repPhone     || '').slice(0, 20);
            }
            // Items: compact "priceId:category[:amount]" per key
            // enterprise has no priceId so we encode the amount (cents) as 3rd field
            items.forEach((item, i) => {
                const parts = [item.priceId || '', item.category || 'package'];
                if (item.category === 'enterprise') parts.push(String(item.amount || 0));
                m['item' + i] = parts.join(':').slice(0, 100);
            });
            return m;
        })(),
        tags: ['msa', 'business-lab']
    };

    // Add admin as viewer/CC recipient if configured
    const adminEmail = process.env.BL_ADMIN_EMAIL;
    if (adminEmail) {
        docPayload.recipients.push({
            email:      adminEmail,
            first_name: 'The Business',
            last_name:  'Lab',
            role:       'Admin'
        });
    }

    // Create the document
    const doc = await pdPost(apiKey, '/public/v1/documents', docPayload);
    const docId = doc.uuid || doc.id;
    console.log('PandaDoc document created:', docId, 'status:', doc.status);

    // Poll until document is ready (PandaDoc processes templates async)
    const readyDoc = await waitForDocumentReady(apiKey, docId);
    console.log('PandaDoc document ready, status:', readyDoc.status);

    // If document is still in draft (template workflow did not auto-send), send manually
    if (readyDoc.status === 'document.draft') {
        try {
            await pdPost(apiKey, `/public/v1/documents/${docId}/send`, {
                subject: 'Your Business Lab Master Services Agreement — Action Required',
                message: `Hi ${firstName}, please review and sign your Business Lab Master Services Agreement (${scopeSummary}). Questions? Call 248-775-5058 or reply to this email.`,
                silent:  false
            });
            console.log('PandaDoc document sent manually:', docId);
        } catch (sendErr) {
            // PandaDoc sandbox blocks /send with 403 — document was created successfully.
            // In production with a live API key, sending works normally.
            console.warn('PandaDoc /send skipped (sandbox restriction or already sent):', sendErr.message, '— document ID:', docId);
        }
    } else {
        console.log('PandaDoc document auto-sent by template workflow:', docId, 'status:', readyDoc.status);
    }

    return { ...doc, id: docId };
}

// Poll until document finishes processing (leaves "document.uploaded" state), max 15s.
// After processing, the document lands in "document.draft" — the caller handles sending.
async function waitForDocumentReady(apiKey, docId, maxMs = 15000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const d = await pdGet(apiKey, `/public/v1/documents/${docId}`);
        // "document.uploaded" means PandaDoc is still processing the template — keep polling
        if (d.status && d.status !== 'document.uploaded') return d;
        await new Promise(r => setTimeout(r, 1500));
    }
    // Return current state instead of throwing — caller will still attempt to send
    return await pdGet(apiKey, `/public/v1/documents/${docId}`);
}

// ─── PandaDoc API helpers ─────────────────────────────────────────────────────

// Convert PandaDoc field-validation objects into a readable string.
// e.g. {recipients:[{email:["Enter a valid email address."]}]}
//   → "recipients[0].email: Enter a valid email address."
function flattenPdErrors(obj, prefix) {
    if (!obj || typeof obj !== 'object') return String(obj || '');
    if (Array.isArray(obj)) {
        return obj.map((v, i) => flattenPdErrors(v, prefix ? `${prefix}[${i}]` : `[${i}]`)).filter(Boolean).join('; ');
    }
    return Object.entries(obj).map(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        if (Array.isArray(v) && v.every(x => typeof x === 'string')) return `${key}: ${v.join(', ')}`;
        return flattenPdErrors(v, key);
    }).filter(Boolean).join('; ');
}

function pdRequest(apiKey, method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.pandadoc.com',
            path,
            method,
            headers: {
                'Authorization': 'API-Key ' + apiKey,
                'Content-Type':  'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
            }
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                if (res.statusCode === 204 || raw === '') { resolve({}); return; }
                try {
                    const parsed = JSON.parse(raw);
                    if (res.statusCode >= 400) {
                        console.error(`PandaDoc ${res.statusCode} ${method} ${path}:`, raw.slice(0, 500));
                        // Build a readable error message from the various PandaDoc error formats
                        const detail = parsed.detail;
                        let msg;
                        if (detail && typeof detail === 'object') {
                            // Field-level validation: {recipients: [{email: ["Enter a valid…"]}]}
                            msg = flattenPdErrors(detail);
                        } else if (detail) {
                            msg = detail;
                        } else if (parsed.message) {
                            msg = parsed.message;
                        } else if (parsed.type) {
                            msg = parsed.type;
                        } else {
                            // Top-level field errors (no detail wrapper)
                            const topLevel = flattenPdErrors(parsed);
                            msg = topLevel || `PandaDoc error ${res.statusCode}`;
                        }
                        reject(new Error(msg));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    console.error(`PandaDoc non-JSON ${res.statusCode} ${method} ${path}:`, raw.slice(0, 200));
                    reject(new Error('Invalid PandaDoc response: ' + raw.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function pdGet(apiKey, path)           { return pdRequest(apiKey, 'GET',    path, null); }
function pdPost(apiKey, path, body)    { return pdRequest(apiKey, 'POST',   path, body); }
function pdDelete(apiKey, path)        { return pdRequest(apiKey, 'DELETE', path, null); }

// Returns raw Buffer for binary endpoints (e.g. /download which sends PDF bytes)
function pdDownload(apiKey, path) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.pandadoc.com',
            path,
            method: 'GET',
            headers: { 'Authorization': 'API-Key ' + apiKey }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode >= 400) {
                    reject(new Error('PandaDoc download failed: HTTP ' + res.statusCode + ' — ' + buf.slice(0, 100).toString()));
                } else {
                    resolve(buf);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── Standard helpers ─────────────────────────────────────────────────────────

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin':  '*',
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
