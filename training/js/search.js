/* ============================================================
   Client-Side Search — The Business Lab Training Portal
   Weighted keyword matching against search-index.js
   ============================================================ */

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const query = (params.get('q') || '').trim();

  const input = document.getElementById('searchInput');
  const resultsDiv = document.getElementById('searchResults');
  const countSpan = document.getElementById('resultCount');

  if (!input || !resultsDiv) return;

  if (query) {
    input.value = query;
    runSearch(query);
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && this.value.trim()) {
      const q = this.value.trim();
      history.replaceState(null, '', 'search.html?q=' + encodeURIComponent(q));
      runSearch(q);
    }
  });

  function runSearch(q) {
    if (typeof SEARCH_INDEX === 'undefined') {
      resultsDiv.innerHTML = '<div class="no-results"><i class="fa-solid fa-circle-exclamation"></i><p>Search index not loaded.</p></div>';
      return;
    }

    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];

    for (const entry of SEARCH_INDEX) {
      let score = 0;
      const titleLower = entry.title.toLowerCase();
      const keywordsLower = (entry.keywords || []).map(k => k.toLowerCase());
      const excerptLower = (entry.excerpt || '').toLowerCase();

      for (const term of terms) {
        // Title match (highest weight)
        if (titleLower.includes(term)) score += 10;
        // Keyword match
        for (const kw of keywordsLower) {
          if (kw.includes(term)) score += 5;
        }
        // Excerpt match
        if (excerptLower.includes(term)) score += 2;
        // Module match
        if ((entry.module || '').toLowerCase().includes(term)) score += 3;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    if (countSpan) {
      countSpan.textContent = scored.length + ' result' + (scored.length !== 1 ? 's' : '');
    }

    if (scored.length === 0) {
      resultsDiv.innerHTML = `
        <div class="no-results">
          <i class="fa-solid fa-magnifying-glass"></i>
          <p>No results found for "<strong>${escapeHTML(q)}</strong>"</p>
          <p>Try different keywords or browse the modules in the sidebar.</p>
        </div>`;
      return;
    }

    let html = '';
    for (const { entry } of scored) {
      const highlighted = highlightExcerpt(entry.excerpt || '', terms);
      html += `
        <div class="search-result">
          <h3><a href="${entry.url}">${escapeHTML(entry.title)}</a></h3>
          <div class="result-path">${escapeHTML(entry.module)} &rsaquo; ${escapeHTML(entry.title)}</div>
          <div class="result-excerpt">${highlighted}</div>
        </div>`;
    }

    resultsDiv.innerHTML = html;
  }

  function highlightExcerpt(text, terms) {
    let safe = escapeHTML(text);
    for (const term of terms) {
      const re = new RegExp('(' + escapeRegex(term) + ')', 'gi');
      safe = safe.replace(re, '<mark>$1</mark>');
    }
    return safe;
  }

  function escapeHTML(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
})();
