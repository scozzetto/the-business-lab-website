/* ============================================================
   Shared Components — The Business Lab Training Portal
   Injects sidebar, topbar, breadcrumbs, TOC, prev/next on every page.
   Requires nav-data.js loaded first.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Helpers ---------- */
  const ROOT = getRootPath();

  function getRootPath() {
    const depth = (location.pathname.match(/\//g) || []).length - 1;
    // If served from a subdirectory or root, calculate relative path
    const path = location.pathname.replace(/\/[^/]*$/, '/');
    const segments = path.split('/').filter(Boolean);
    // Determine how deep we are relative to index.html
    // Look at the current script's path to infer root
    const scripts = document.getElementsByTagName('script');
    for (let s of scripts) {
      const src = s.getAttribute('src') || '';
      if (src.includes('components.js')) {
        const prefix = src.replace('js/components.js', '');
        return prefix || './';
      }
    }
    return './';
  }

  function currentPage() {
    const path = location.pathname;
    for (const mod of NAV_DATA) {
      for (const page of mod.pages) {
        if (path.endsWith(page.file) || path.endsWith('/' + page.file)) {
          return { module: mod, page: page };
        }
      }
    }
    // Check if we're on home or search
    if (path.endsWith('/index.html') || path.endsWith('/') || path === '') {
      // Could be module index or home
      for (const mod of NAV_DATA) {
        for (const page of mod.pages) {
          if (path.endsWith(page.file)) return { module: mod, page: page };
        }
      }
    }
    return null;
  }

  function flatPages() {
    const flat = [];
    for (const mod of NAV_DATA) {
      for (const page of mod.pages) {
        flat.push({ module: mod, page: page });
      }
    }
    return flat;
  }

  /* ---------- Build Sidebar ---------- */
  function buildSidebar() {
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'sidebar';

    const cur = currentPage();

    sidebar.innerHTML = `
      <div class="sidebar-header">
        <a href="${ROOT}index.html" class="sidebar-logo">
          <div class="icon-box"><i class="fa-solid fa-flask"></i></div>
          <div class="logo-text">The Business Lab<small>Training Portal</small></div>
        </a>
      </div>
      <div class="sidebar-search">
        <div class="sidebar-search-wrap">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input type="text" placeholder="Search training..." id="sidebarSearch" autocomplete="off">
        </div>
      </div>
      <nav class="sidebar-nav" id="sidebarNav"></nav>
      <div class="sidebar-back-link" style="padding: 1rem 1.5rem; border-top: 1px solid #e2e8f0; margin-top: auto;">
        <a href="/" style="display: flex; align-items: center; gap: 0.5rem; color: #64748b; font-size: 0.85rem; text-decoration: none; transition: color 0.2s;">
          <i class="fa-solid fa-arrow-left" style="font-size: 0.75rem;"></i> Back to thebusiness-lab.com
        </a>
      </div>
    `;

    const nav = sidebar.querySelector('#sidebarNav');

    for (const mod of NAV_DATA) {
      const isActive = cur && cur.module.id === mod.id;
      const div = document.createElement('div');
      div.className = 'nav-module' + (isActive ? ' open active' : '');

      let pagesHTML = '';
      for (const page of mod.pages) {
        const isCurrent = cur && cur.page.slug === page.slug && cur.module.id === mod.id;
        pagesHTML += `<a href="${ROOT}${page.file}" class="nav-page-link${isCurrent ? ' active' : ''}">${page.title}</a>`;
      }

      div.innerHTML = `
        <button class="nav-module-toggle" aria-expanded="${isActive}">
          <i class="module-icon ${mod.icon}"></i>
          <span class="module-label">${mod.title}</span>
          <i class="fa-solid fa-chevron-right chevron"></i>
        </button>
        <div class="nav-pages">${pagesHTML}</div>
      `;

      div.querySelector('.nav-module-toggle').addEventListener('click', function () {
        const parent = this.closest('.nav-module');
        const wasOpen = parent.classList.contains('open');
        // Close others
        nav.querySelectorAll('.nav-module.open').forEach(m => {
          if (m !== parent) m.classList.remove('open');
        });
        parent.classList.toggle('open', !wasOpen);
        this.setAttribute('aria-expanded', !wasOpen);
      });

      nav.appendChild(div);
    }

    // Search handler
    sidebar.querySelector('#sidebarSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && this.value.trim()) {
        location.href = ROOT + 'search.html?q=' + encodeURIComponent(this.value.trim());
      }
    });

    return sidebar;
  }

  /* ---------- Build Overlay ---------- */
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    overlay.addEventListener('click', closeSidebar);
    return overlay;
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  }

  /* ---------- Build Topbar ---------- */
  function buildTopbar() {
    const topbar = document.createElement('header');
    topbar.className = 'topbar';

    const cur = currentPage();

    let crumbs = `<a href="${ROOT}index.html"><i class="fa-solid fa-house"></i></a>`;
    if (cur) {
      crumbs += `<span class="sep">/</span>`;
      crumbs += `<a href="${ROOT}${cur.module.pages[0].file}">${cur.module.title}</a>`;
      if (cur.page.slug !== 'index') {
        crumbs += `<span class="sep">/</span>`;
        crumbs += `<span class="current">${cur.page.title}</span>`;
      } else {
        // We're on the module index, make it current
        crumbs = crumbs.replace(/<a href="[^"]*">((?:(?!<\/a>).)*)<\/a>$/, '<span class="current">$1</span>');
      }
    }

    topbar.innerHTML = `
      <button class="hamburger" id="hamburger" aria-label="Toggle menu">
        <i class="fa-solid fa-bars"></i>
      </button>
      <div class="breadcrumbs">${crumbs}</div>
    `;

    topbar.querySelector('#hamburger').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarOverlay').classList.toggle('open');
    });

    return topbar;
  }

  /* ---------- Build TOC ---------- */
  function buildTOC() {
    const headings = document.querySelectorAll('.page-content h2[id]');
    if (headings.length < 2) return null;

    const toc = document.createElement('aside');
    toc.className = 'toc';

    let html = '<div class="toc-title">On This Page</div><ul class="toc-list">';
    headings.forEach(h => {
      html += `<li><a href="#${h.id}">${h.textContent}</a></li>`;
    });
    html += '</ul>';
    toc.innerHTML = html;

    // Scroll spy
    const links = toc.querySelectorAll('a');
    let ticking = false;

    function updateActive() {
      let current = null;
      headings.forEach(h => {
        if (h.getBoundingClientRect().top <= 100) current = h;
      });
      links.forEach(a => {
        a.classList.toggle('active', current && a.getAttribute('href') === '#' + current.id);
      });
      ticking = false;
    }

    window.addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(updateActive); ticking = true; }
    });
    updateActive();

    return toc;
  }

  /* ---------- Build Prev/Next ---------- */
  function buildLessonNav() {
    const cur = currentPage();
    if (!cur) return null;

    const flat = flatPages();
    const idx = flat.findIndex(f => f.module.id === cur.module.id && f.page.slug === cur.page.slug);
    if (idx === -1) return null;

    const prev = idx > 0 ? flat[idx - 1] : null;
    const next = idx < flat.length - 1 ? flat[idx + 1] : null;

    if (!prev && !next) return null;

    const nav = document.createElement('nav');
    nav.className = 'lesson-nav';

    if (prev) {
      nav.innerHTML += `
        <a href="${ROOT}${prev.page.file}" class="prev">
          <span class="nav-label"><i class="fa-solid fa-arrow-left"></i> Previous</span>
          <span class="nav-title">${prev.page.title}</span>
        </a>`;
    }
    if (next) {
      nav.innerHTML += `
        <a href="${ROOT}${next.page.file}" class="next">
          <span class="nav-label">Next <i class="fa-solid fa-arrow-right"></i></span>
          <span class="nav-title">${next.page.title}</span>
        </a>`;
    }

    return nav;
  }

  /* ---------- Inject Everything ---------- */
  function init() {
    const app = document.querySelector('.app');
    if (!app) return;

    // Sidebar + Overlay
    const sidebar = buildSidebar();
    const overlay = buildOverlay();
    app.prepend(overlay);
    app.prepend(sidebar);

    // Main wrapper
    const main = app.querySelector('.main');
    if (!main) return;

    // Topbar
    const topbar = buildTopbar();
    main.prepend(topbar);

    // Content area wrapper
    const pageContent = main.querySelector('.page-content');
    if (pageContent) {
      // Wrap in content-area div if not already
      if (!pageContent.parentElement.classList.contains('content-area')) {
        const contentArea = document.createElement('div');
        contentArea.className = 'content-area';
        pageContent.parentNode.insertBefore(contentArea, pageContent);
        contentArea.appendChild(pageContent);

        // TOC
        const toc = buildTOC();
        if (toc) contentArea.appendChild(toc);
      }

      // Prev/Next
      const lessonNav = buildLessonNav();
      if (lessonNav) pageContent.appendChild(lessonNav);
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
