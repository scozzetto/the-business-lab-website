/**
 * Business Lab Billing — Stripe subscription management
 *
 * Actions:
 *   list-customers     — list all Stripe customers
 *   list-subscriptions — list all subscriptions (with optional customer filter)
 *   create-customer    — create new customer with metadata
 *   create-subscription — create subscription with ACH or card
 *   update-subscription — update subscription (price, quantity, metadata)
 *   cancel-subscription — cancel a subscription
 *   list-invoices      — list invoices for a customer
 *   list-products      — list all products/prices
 *   create-product     — create a product + price
 *
 * Env vars needed: STRIPE_SECRET_KEY, BL_ADMIN_KEY
 */

exports.handler = async (event) => {
    // CORS
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders(), body: '' };
    }

    // Auth check — must happen FIRST before anything else
    const adminKey = process.env.BL_ADMIN_KEY;
    if (!adminKey) {
        return respond(500, { error: 'Server misconfigured: admin key not set', auth_failed: true });
    }
    const auth = (event.headers['x-admin-key'] || '').trim();
    if (!auth || auth !== adminKey) {
        return respond(401, { error: 'Invalid admin key', auth_failed: true });
    }

    // Stripe init — after auth passes
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
        return respond(500, { error: 'Stripe key not configured. Add STRIPE_SECRET_KEY in Netlify env vars.', auth_ok: true });
    }
    const stripe = require('stripe')(stripeKey);

    if (event.httpMethod !== 'POST') {
        return respond(405, { error: 'POST only' });
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return respond(400, { error: 'Invalid JSON' }); }

    const action = body.action;

    try {
        switch (action) {

            // ─── LIST CUSTOMERS ───
            case 'list-customers': {
                const customers = await stripe.customers.list({
                    limit: body.limit || 100,
                    expand: ['data.subscriptions']
                });
                return respond(200, { success: true, customers: customers.data });
            }

            // ─── LIST SUBSCRIPTIONS ───
            case 'list-subscriptions': {
                const params = {
                    limit: body.limit || 100,
                    status: body.status || 'all',
                    expand: ['data.customer', 'data.items.data.price.product']
                };
                if (body.customerId) params.customer = body.customerId;
                const subs = await stripe.subscriptions.list(params);
                return respond(200, { success: true, subscriptions: subs.data });
            }

            // ─── CREATE CUSTOMER ───
            case 'create-customer': {
                if (!body.name) return respond(400, { error: 'name required' });
                const custData = {
                    name: body.name,
                    email: body.email || undefined,
                    phone: body.phone || undefined,
                    metadata: body.metadata || {}
                };
                if (body.address) custData.address = body.address;
                const customer = await stripe.customers.create(custData);
                return respond(200, { success: true, customer });
            }

            // ─── UPDATE CUSTOMER ───
            case 'update-customer': {
                if (!body.customerId) return respond(400, { error: 'customerId required' });
                const custUpdate = {};
                if (body.name !== undefined) custUpdate.name = body.name;
                if (body.email !== undefined) custUpdate.email = body.email;
                if (body.phone !== undefined) custUpdate.phone = body.phone;
                if (body.metadata) custUpdate.metadata = body.metadata;
                if (body.address) custUpdate.address = body.address;
                const updatedCust = await stripe.customers.update(body.customerId, custUpdate);
                return respond(200, { success: true, customer: updatedCust });
            }

            // ─── DELETE CUSTOMER ───
            case 'delete-customer': {
                if (!body.customerId) return respond(400, { error: 'customerId required' });
                await stripe.customers.del(body.customerId);
                return respond(200, { success: true });
            }

            // ─── CREATE PAYMENT LINK (so client can enter their own payment method) ───
            case 'create-payment-link': {
                if (!body.priceId) return respond(400, { error: 'priceId required' });
                const plData = {
                    line_items: [{ price: body.priceId, quantity: body.quantity || 1 }],
                    payment_method_types: body.paymentMethods || ['card', 'us_bank_account'],
                    metadata: body.metadata || {}
                };
                if (body.customerId) {
                    // Use Checkout Session instead for existing customers
                    const session = await stripe.checkout.sessions.create({
                        customer: body.customerId,
                        line_items: [{ price: body.priceId, quantity: body.quantity || 1 }],
                        mode: 'subscription',
                        payment_method_types: body.paymentMethods || ['card', 'us_bank_account'],
                        success_url: (body.successUrl || 'https://thebusiness-lab.com') + '?session_id={CHECKOUT_SESSION_ID}',
                        cancel_url: body.cancelUrl || 'https://thebusiness-lab.com',
                        subscription_data: { metadata: body.metadata || {} },
                        metadata: body.metadata || {}
                    });
                    return respond(200, { success: true, url: session.url, sessionId: session.id });
                }
                const link = await stripe.paymentLinks.create(plData);
                return respond(200, { success: true, url: link.url, linkId: link.id });
            }

            // ─── CREATE SUBSCRIPTION ───
            case 'create-subscription': {
                if (!body.customerId) return respond(400, { error: 'customerId required' });
                if (!body.priceId) return respond(400, { error: 'priceId required' });

                const subData = {
                    customer: body.customerId,
                    items: [{ price: body.priceId, quantity: body.quantity || 1 }],
                    metadata: body.metadata || {},
                    collection_method: body.autoCharge ? 'charge_automatically' : 'send_invoice',
                    payment_settings: {
                        payment_method_types: body.paymentMethods || ['card', 'us_bank_account', 'cashapp', 'link']
                    }
                };
                if (!body.autoCharge) {
                    subData.days_until_due = body.daysUntilDue || 30;
                }
                if (body.trialDays) {
                    subData.trial_period_days = body.trialDays;
                }
                // Start date — trial_end suppresses all invoicing until the start date.
                // (billing_cycle_anchor + proration_behavior:'none' created a spurious $0
                // invoice for the partial period, causing duplicate invoices per customer.)
                if (body.startDate) {
                    const startTs = Math.floor(new Date(body.startDate + 'T00:00:00').getTime() / 1000);
                    const nowTs = Math.floor(Date.now() / 1000);
                    if (startTs > nowTs) {
                        subData.trial_end = startTs;
                        delete subData.trial_period_days; // Stripe rejects both simultaneously
                    }
                }
                // End date — cancel_at sets automatic cancellation
                if (body.endDate) {
                    subData.cancel_at = Math.floor(new Date(body.endDate + 'T23:59:59').getTime() / 1000);
                }
                const sub = await stripe.subscriptions.create(subData);
                return respond(200, { success: true, subscription: sub });
            }

            // ─── UPDATE SUBSCRIPTION ───
            case 'update-subscription': {
                if (!body.subscriptionId) return respond(400, { error: 'subscriptionId required' });
                const updateData = {};
                if (body.metadata) updateData.metadata = body.metadata;
                if (body.cancel_at_period_end !== undefined) updateData.cancel_at_period_end = body.cancel_at_period_end;
                const updated = await stripe.subscriptions.update(body.subscriptionId, updateData);
                return respond(200, { success: true, subscription: updated });
            }

            // ─── CANCEL SUBSCRIPTION ───
            case 'cancel-subscription': {
                if (!body.subscriptionId) return respond(400, { error: 'subscriptionId required' });
                const canceled = await stripe.subscriptions.cancel(body.subscriptionId);
                return respond(200, { success: true, subscription: canceled });
            }

            // ─── LIST INVOICES ───
            case 'list-invoices': {
                const invParams = { limit: body.limit || 50 };
                if (body.customerId) invParams.customer = body.customerId;
                if (body.status) invParams.status = body.status;
                const invoices = await stripe.invoices.list(invParams);
                return respond(200, { success: true, invoices: invoices.data });
            }

            // ─── GET INVOICE (with line items + charge/payment details) ───
            case 'get-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                const invoice = await stripe.invoices.retrieve(body.invoiceId, {
                    expand: [
                        'lines.data',
                        'customer',
                        'charge',
                        'charge.balance_transaction'
                    ]
                });
                return respond(200, { success: true, invoice });
            }

            // ─── VOID INVOICE ───
            case 'void-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                const voided = await stripe.invoices.voidInvoice(body.invoiceId);
                return respond(200, { success: true, invoice: voided });
            }

            // ─── UPDATE INVOICE (draft only — description, metadata, due date) ───
            case 'update-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                const invUpdate = {};
                if (body.description !== undefined) invUpdate.description = body.description;
                if (body.metadata) invUpdate.metadata = body.metadata;
                if (body.days_until_due !== undefined) invUpdate.days_until_due = body.days_until_due;
                if (body.due_date !== undefined) invUpdate.due_date = body.due_date;
                const updatedInv = await stripe.invoices.update(body.invoiceId, invUpdate);
                return respond(200, { success: true, invoice: updatedInv });
            }

            // ─── SEND INVOICE (finalize + send email) ───
            case 'send-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                // Finalize if still draft
                let inv = await stripe.invoices.retrieve(body.invoiceId);
                if (inv.status === 'draft') {
                    inv = await stripe.invoices.finalizeInvoice(body.invoiceId);
                }
                const sent = await stripe.invoices.sendInvoice(body.invoiceId);
                return respond(200, { success: true, invoice: sent });
            }

            // ─── MARK INVOICE AS PAID ───
            case 'pay-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                const paid = await stripe.invoices.pay(body.invoiceId, {
                    paid_out_of_band: body.outOfBand || false
                });
                return respond(200, { success: true, invoice: paid });
            }

            // ─── CREATE STANDALONE INVOICE ───
            case 'create-invoice': {
                if (!body.customerId) return respond(400, { error: 'customerId required' });
                const invData = {
                    customer: body.customerId,
                    collection_method: 'send_invoice',
                    metadata: body.metadata || {}
                };
                if (body.description) invData.description = body.description;
                if (body.due_date) {
                    invData.due_date = body.due_date;
                } else {
                    invData.days_until_due = body.daysUntilDue || 30;
                }
                const newInv = await stripe.invoices.create(invData);
                // Add line items
                if (body.items && body.items.length) {
                    for (const item of body.items) {
                        await stripe.invoiceItems.create({
                            customer: body.customerId,
                            invoice: newInv.id,
                            description: item.description || 'Service',
                            amount: item.amount,
                            currency: 'usd'
                        });
                    }
                }
                // Auto-finalize and send if requested
                let finalInv = newInv;
                if (body.autoSend) {
                    finalInv = await stripe.invoices.finalizeInvoice(newInv.id);
                    finalInv = await stripe.invoices.sendInvoice(newInv.id);
                }
                return respond(200, { success: true, invoice: finalInv });
            }

            // ─── DELETE DRAFT INVOICE ───
            case 'delete-invoice': {
                if (!body.invoiceId) return respond(400, { error: 'invoiceId required' });
                await stripe.invoices.del(body.invoiceId);
                return respond(200, { success: true });
            }

            // ─── LIST PRODUCTS ───
            case 'list-products': {
                const products = await stripe.products.list({ limit: 100, active: true });
                const prices = await stripe.prices.list({ limit: 100, active: true, expand: ['data.product'] });
                return respond(200, { success: true, products: products.data, prices: prices.data });
            }

            // ─── CREATE PRODUCT + PRICE ───
            case 'create-product': {
                if (!body.name) return respond(400, { error: 'name required' });
                if (!body.amount) return respond(400, { error: 'amount required (in cents)' });
                const product = await stripe.products.create({
                    name: body.name,
                    description: body.description || undefined,
                    metadata: body.metadata || {}
                });
                const price = await stripe.prices.create({
                    product: product.id,
                    unit_amount: body.amount,
                    currency: 'usd',
                    recurring: { interval: body.interval || 'month' }
                });
                return respond(200, { success: true, product, price });
            }

            // ─── UPDATE PRODUCT (name/description/metadata; price change = archive + create new) ───
            case 'update-product': {
                if (!body.productId) return respond(400, { error: 'productId required' });
                const prodUpdate = {};
                if (body.name !== undefined) prodUpdate.name = body.name;
                if (body.description !== undefined) prodUpdate.description = body.description || '';
                if (body.metadata) prodUpdate.metadata = body.metadata;
                const updatedProduct = await stripe.products.update(body.productId, prodUpdate);

                let newPrice = null;
                if (body.priceId && body.amount !== undefined) {
                    const oldPrice = await stripe.prices.retrieve(body.priceId);
                    if (oldPrice.unit_amount !== body.amount) {
                        await stripe.prices.update(body.priceId, { active: false });
                        const priceData = { product: body.productId, unit_amount: body.amount, currency: 'usd' };
                        if (oldPrice.recurring) priceData.recurring = { interval: oldPrice.recurring.interval };
                        newPrice = await stripe.prices.create(priceData);
                    }
                }
                return respond(200, { success: true, product: updatedProduct, newPrice });
            }

            // ─── ARCHIVE PRODUCT (deactivates product + all its active prices) ───
            case 'archive-product': {
                if (!body.productId) return respond(400, { error: 'productId required' });
                const priceList = await stripe.prices.list({ product: body.productId, active: true, limit: 100 });
                for (const pr of priceList.data) {
                    await stripe.prices.update(pr.id, { active: false });
                }
                const archivedProduct = await stripe.products.update(body.productId, { active: false });
                return respond(200, { success: true, product: archivedProduct });
            }

            // ─── SETUP INTENT (for saving payment methods) ───
            case 'create-setup-intent': {
                if (!body.customerId) return respond(400, { error: 'customerId required' });
                const setupIntent = await stripe.setupIntents.create({
                    customer: body.customerId,
                    payment_method_types: body.paymentMethods || ['card', 'us_bank_account']
                });
                return respond(200, { success: true, clientSecret: setupIntent.client_secret });
            }

            // ─── SEED TIER PRODUCTS ───
            case 'seed-tier-products': {
                const tiers = [
                    { name: 'Basic',        tier: 'basic',        monthly: 20000,  annual: 216000  },
                    { name: 'Professional', tier: 'professional', monthly: 50000,  annual: 540000  },
                    { name: 'Enterprise',   tier: 'enterprise',   monthly: 100000, annual: 1080000 }
                ];
                const existing = await stripe.products.list({ limit: 100, active: true });
                const existingByTier = {};
                existing.data.forEach(p => {
                    if (p.metadata && p.metadata.bl_tier) existingByTier[p.metadata.bl_tier] = p;
                });
                const created = [], skipped = [];
                for (const t of tiers) {
                    if (existingByTier[t.tier]) { skipped.push(t.name); continue; }
                    const product = await stripe.products.create({
                        name: t.name,
                        description: `The Business Lab ${t.name} service tier`,
                        metadata: { bl_tier: t.tier }
                    });
                    await stripe.prices.create({
                        product: product.id,
                        unit_amount: t.monthly,
                        currency: 'usd',
                        recurring: { interval: 'month' },
                        metadata: { bl_tier: t.tier, bl_cadence: 'monthly' }
                    });
                    await stripe.prices.create({
                        product: product.id,
                        unit_amount: t.annual,
                        currency: 'usd',
                        recurring: { interval: 'year' },
                        metadata: { bl_tier: t.tier, bl_cadence: 'annual' }
                    });
                    created.push(t.name);
                }
                return respond(200, { success: true, created, skipped });
            }

            default:
                return respond(400, { error: 'Unknown action: ' + action });
        }
    } catch (err) {
        console.error('Stripe error:', err.message);
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

function respond(code, data) {
    return {
        statusCode: code,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    };
}
