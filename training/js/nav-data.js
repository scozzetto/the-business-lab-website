/* ============================================================
   Navigation Data — The Business Lab Training Portal
   Add a new page = add one entry. components.js reads this.
   ============================================================ */

const NAV_DATA = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: 'fa-solid fa-rocket',
    pages: [
      { slug: 'index',               title: 'Module Overview',          file: 'getting-started/index.html' },
      { slug: 'logging-in',          title: 'Logging In',               file: 'getting-started/logging-in.html' },
      { slug: 'staff-portal-layout', title: 'Staff Portal Layout',      file: 'getting-started/staff-portal-layout.html' },
      { slug: 'profile-setup',       title: 'Profile Setup',            file: 'getting-started/profile-setup.html' },
      { slug: 'location-management', title: 'Location Management',      file: 'getting-started/location-management.html' }
    ]
  },
  {
    id: 'client-database',
    title: 'Client Database',
    icon: 'fa-solid fa-users',
    pages: [
      { slug: 'index',                title: 'Module Overview',          file: 'client-database/index.html' },
      { slug: 'overview',             title: 'Database Overview',        file: 'client-database/overview.html' },
      { slug: 'searching',            title: 'Searching for Clients',    file: 'client-database/searching.html' },
      { slug: 'adding-clients',       title: 'Adding New Clients',       file: 'client-database/adding-clients.html' },
      { slug: 'editing-clients',      title: 'Editing Client Records',   file: 'client-database/editing-clients.html' },
      { slug: 'client-status',        title: 'Client Status & Tags',     file: 'client-database/client-status.html' },
      { slug: 'trash-system',         title: 'Trash & Recovery',         file: 'client-database/trash-system.html' },
      { slug: 'exporting',            title: 'Exporting Data',           file: 'client-database/exporting.html' },
      { slug: 'family-relationships', title: 'Family Relationships',     file: 'client-database/family-relationships.html' }
    ]
  },
  {
    id: 'billing',
    title: 'Billing & Payments',
    icon: 'fa-solid fa-credit-card',
    pages: [
      { slug: 'index',                  title: 'Module Overview',          file: 'billing/index.html' },
      { slug: 'overview',               title: 'Billing Overview',         file: 'billing/overview.html' },
      { slug: 'card-payments',          title: 'Card Payments',            file: 'billing/card-payments.html' },
      { slug: 'cash-check-payments',    title: 'Cash & Check Payments',    file: 'billing/cash-check-payments.html' },
      { slug: 'quick-purchase',         title: 'Quick Purchase',           file: 'billing/quick-purchase.html' },
      { slug: 'saved-cards',            title: 'Saved Cards',              file: 'billing/saved-cards.html' },
      { slug: 'billing-statements',     title: 'Billing Statements',       file: 'billing/billing-statements.html' },
      { slug: 'writeoffs-adjustments',  title: 'Write-offs & Adjustments', file: 'billing/writeoffs-adjustments.html' },
      { slug: 'receipts',               title: 'Receipts',                 file: 'billing/receipts.html' },
      { slug: 'payment-history',        title: 'Payment History',          file: 'billing/payment-history.html' }
    ]
  },
  {
    id: 'front-desk',
    title: 'Front Desk Operations',
    icon: 'fa-solid fa-bell-concierge',
    pages: [
      { slug: 'index',            title: 'Module Overview',          file: 'front-desk/index.html' },
      { slug: 'dashboard',        title: 'Front Desk Dashboard',     file: 'front-desk/dashboard.html' },
      { slug: 'check-in',         title: 'Client Check-In',          file: 'front-desk/check-in.html' },
      { slug: 'walk-ins',         title: 'Handling Walk-Ins',        file: 'front-desk/walk-ins.html' },
      { slug: 'task-management',  title: 'Task Management',          file: 'front-desk/task-management.html' },
      { slug: 'end-of-day',       title: 'End of Day Procedures',    file: 'front-desk/end-of-day.html' }
    ]
  },
  {
    id: 'pos',
    title: 'Point of Sale',
    icon: 'fa-solid fa-cash-register',
    pages: [
      { slug: 'index',             title: 'Module Overview',          file: 'pos/index.html' },
      { slug: 'terminal-overview', title: 'Terminal Overview',         file: 'pos/terminal-overview.html' },
      { slug: 'processing-sales',  title: 'Processing Sales',         file: 'pos/processing-sales.html' },
      { slug: 'discounts-promos',  title: 'Discounts & Promotions',   file: 'pos/discounts-promos.html' },
      { slug: 'returns-refunds',   title: 'Returns & Refunds',        file: 'pos/returns-refunds.html' },
      { slug: 'cash-drawer',       title: 'Cash Drawer Management',   file: 'pos/cash-drawer.html' },
      { slug: 'receipts-printing', title: 'Receipts & Printing',      file: 'pos/receipts-printing.html' },
      { slug: 'daily-reports',     title: 'Daily POS Reports',        file: 'pos/daily-reports.html' }
    ]
  },
  {
    id: 'booking',
    title: 'Booking & Scheduling',
    icon: 'fa-solid fa-calendar-check',
    pages: [
      { slug: 'index',              title: 'Module Overview',             file: 'booking/index.html' },
      { slug: 'calendar-overview',  title: 'Calendar Overview',           file: 'booking/calendar-overview.html' },
      { slug: 'creating-bookings',  title: 'Creating Bookings',           file: 'booking/creating-bookings.html' },
      { slug: 'managing-bookings',  title: 'Managing Bookings',           file: 'booking/managing-bookings.html' },
      { slug: 'provider-schedules', title: 'Provider Schedules',          file: 'booking/provider-schedules.html' },
      { slug: 'notifications',      title: 'Booking Notifications',       file: 'booking/notifications.html' }
    ]
  },
  {
    id: 'menu-management',
    title: 'Menu & Catalog',
    icon: 'fa-solid fa-tags',
    pages: [
      { slug: 'index',             title: 'Module Overview',          file: 'menu-management/index.html' },
      { slug: 'catalog-overview',  title: 'Catalog Overview',         file: 'menu-management/catalog-overview.html' },
      { slug: 'adding-items',      title: 'Adding Items',             file: 'menu-management/adding-items.html' },
      { slug: 'categories',        title: 'Categories & Organization',file: 'menu-management/categories.html' },
      { slug: 'pricing',           title: 'Pricing & Variants',       file: 'menu-management/pricing.html' },
      { slug: 'inventory',         title: 'Inventory Tracking',       file: 'menu-management/inventory.html' }
    ]
  },
  {
    id: 'accounting',
    title: 'Accounting & Reports',
    icon: 'fa-solid fa-chart-line',
    pages: [
      { slug: 'index',            title: 'Module Overview',            file: 'accounting/index.html' },
      { slug: 'dashboard',        title: 'Analytics Dashboard',        file: 'accounting/dashboard.html' },
      { slug: 'revenue-reports',  title: 'Revenue Reports',            file: 'accounting/revenue-reports.html' },
      { slug: 'payment-reports',  title: 'Payment Reports',            file: 'accounting/payment-reports.html' },
      { slug: 'export-reports',   title: 'Exporting Reports',          file: 'accounting/export-reports.html' },
      { slug: 'reconciliation',   title: 'Reconciliation',             file: 'accounting/reconciliation.html' }
    ]
  },
  {
    id: 'staff-management',
    title: 'Staff Management',
    icon: 'fa-solid fa-user-shield',
    pages: [
      { slug: 'index',          title: 'Module Overview',          file: 'staff-management/index.html' },
      { slug: 'adding-staff',   title: 'Adding Staff Members',     file: 'staff-management/adding-staff.html' },
      { slug: 'roles',          title: 'Roles & Permissions',       file: 'staff-management/roles.html' },
      { slug: 'performance',    title: 'Performance Tracking',      file: 'staff-management/performance.html' }
    ]
  },
  {
    id: 'advanced',
    title: 'Advanced Features',
    icon: 'fa-solid fa-wand-magic-sparkles',
    pages: [
      { slug: 'index',            title: 'Module Overview',          file: 'advanced/index.html' },
      { slug: 'email-marketing',  title: 'Email Marketing',          file: 'advanced/email-marketing.html' },
      { slug: 'activity-logs',    title: 'Activity Logs',            file: 'advanced/activity-logs.html' },
      { slug: 'data-backups',     title: 'Data & Backups',           file: 'advanced/data-backups.html' },
      { slug: 'integrations',     title: 'Integrations',             file: 'advanced/integrations.html' }
    ]
  }
];
