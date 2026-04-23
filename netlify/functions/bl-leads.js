/**
 * Business Lab Leads — public intake + admin pipeline management.
 *
 * Leads are stored as Stripe customers with metadata.bl_lead_status set
 * to one of: new | contacted | qualified | proposal | converted | lost.
 * Converting a lead removes the bl_lead_status flag (they become a
 * regular customer, typically right before Send MSA is clicked).
 *
 * Actions:
 *   submit-lead         — PUBLIC. Creates lead customer in Stripe.
 *   list-leads          — ADMIN. Returns all customers tagged as leads.
 *   update-lead-status  — ADMIN. Updates metadata.bl_lead_status.
 *   convert-lead        — ADMIN. Removes bl_lead_status (marks as client).
 *   delete-lead         — ADMIN. Permanently deletes the Stripe customer.
 *
 * Env vars: STRIPE_SECRET_KEY, BL_ADMIN_KEY
 */

const PUBLIC_ACTIONS = new Set(['submit-lead']);
const VALID_STATUSES = new Set(['new', 'contacted', 'qualified', 'proposal', 'converted', 'lost']);

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders(), body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return respond(405, { error: 'POST only' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return respond(400, { error: 'Invalid JSON' }); }

    const action = body.action;
    if (!action) return respond(400, { error: 'action required' });

    // Auth check for non-public actions
    if (!PUBLIC_ACTIONS.has(action)) {
        const adminKey = process.env.BL_ADMIN_KEY;
        if (!adminKey) return respond(500, { error: 'Server misconfigured: admin key not set' });
        const auth = (event.headers['x-admin-key'] || '').trim();
        if (!auth || auth !== adminKey) return respond(401, { error: 'Invalid admin key' });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return respond(500, { error: 'Stripe key not configured' });
    const stripe = require('stripe')(stripeKey);

    try {
        switch (action) {

            // ─── PUBLIC: SUBMIT LEAD ───
            case 'submit-lead': {
                const name    = (body.name    || '').trim().slice(0, 200);
                const email   = (body.email   || '').trim().slice(0, 200);
                const phone   = (body.phone   || '').trim().slice(0, 50);
                const company = (body.company || '').trim().slice(0, 200);
                const serviceInterest = (body.serviceInterest || '').trim().slice(0, 100);
                const budgetRange     = (body.budgetRange     || '').trim().slice(0, 50);
                const notes           = (body.notes           || '').trim().slice(0, 500);

                if (!name)  return respond(400, { error: 'Name is required' });
                if (!email) return respond(400, { error: 'Email is required' });
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    return respond(400, { error: 'Invalid email' });
                }

                const custData = {
                    name,
                    email,
                    metadata: {
                        bl_lead_status:   'new',
                        bl_lead_service:  serviceInterest,
                        bl_lead_budget:   budgetRange,
                        bl_lead_notes:    notes,
                        bl_lead_company:  company,
                        bl_lead_source:   'get-started-form',
                        bl_lead_created:  new Date().toISOString()
                    }
                };
                if (phone)   custData.phone = phone;
                if (company) custData.description = company;

                const customer = await stripe.customers.create(custData);
                return respond(200, { success: true, leadId: customer.id });
            }

            // ─── ADMIN: LIST LEADS ───
            case 'list-leads': {
                // Pull all customers, then filter client-side to those tagged as leads.
                // Stripe doesn't support metadata filtering on customers.list, so this
                // is a small tenant-scale scan; fine under a few hundred customers.
                const all = await stripe.customers.list({
                    limit: 100,
                    expand: ['data.subscriptions']
                });
                const leads = all.data
                    .filter(c => c.metadata && c.metadata.bl_lead_status)
                    .filter(c => !c.metadata.bl_lead_status || c.metadata.bl_lead_status !== 'converted' || (body.includeConverted === true))
                    .map(c => ({
                        id:       c.id,
                        name:     c.name,
                        email:    c.email,
                        phone:    c.phone,
                        status:   c.metadata.bl_lead_status,
                        service:  c.metadata.bl_lead_service  || '',
                        budget:   c.metadata.bl_lead_budget   || '',
                        notes:    c.metadata.bl_lead_notes    || '',
                        company:  c.metadata.bl_lead_company  || '',
                        source:   c.metadata.bl_lead_source   || '',
                        created:  c.metadata.bl_lead_created  || new Date(c.created * 1000).toISOString(),
                        hasSubscription: !!(c.subscriptions && c.subscriptions.data && c.subscriptions.data.length)
                    }))
                    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
                return respond(200, { success: true, leads });
            }

            // ─── ADMIN: UPDATE STATUS ───
            case 'update-lead-status': {
                if (!body.leadId) return respond(400, { error: 'leadId required' });
                if (!VALID_STATUSES.has(body.status)) {
                    return respond(400, { error: 'Invalid status. Allowed: ' + [...VALID_STATUSES].join(', ') });
                }
                const cust = await stripe.customers.update(body.leadId, {
                    metadata: { bl_lead_status: body.status }
                });
                return respond(200, { success: true, leadId: cust.id, status: body.status });
            }

            // ─── ADMIN: CONVERT LEAD (clear lead flag so it becomes a client) ───
            case 'convert-lead': {
                if (!body.leadId) return respond(400, { error: 'leadId required' });
                // Clear the bl_lead_* metadata by setting to empty strings (Stripe metadata-delete convention).
                const cust = await stripe.customers.update(body.leadId, {
                    metadata: {
                        bl_lead_status:  '',
                        bl_lead_service: '',
                        bl_lead_budget:  '',
                        bl_lead_notes:   '',
                        bl_lead_company: '',
                        bl_lead_source:  '',
                        bl_lead_created: ''
                    }
                });
                return respond(200, { success: true, leadId: cust.id });
            }

            // ─── ADMIN: DELETE LEAD ───
            case 'delete-lead': {
                if (!body.leadId) return respond(400, { error: 'leadId required' });
                const del = await stripe.customers.del(body.leadId);
                return respond(200, { success: true, leadId: del.id, deleted: del.deleted });
            }

            default:
                return respond(400, { error: 'Unknown action: ' + action });
        }
    } catch (err) {
        console.error('bl-leads error:', err.message);
        return respond(500, { error: err.message });
    }
};

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}
