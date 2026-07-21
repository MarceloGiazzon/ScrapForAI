(function () {
  'use strict';

  /* ---------- Mobile sidebar toggle ---------- */

  var toggleBtn = document.querySelector('[data-sidebar-toggle]');
  var sidebar = document.querySelector('.sidebar');

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', function () {
      sidebar.classList.toggle('open');
    });

    document.addEventListener('click', function (event) {
      if (!sidebar.classList.contains('open')) return;
      if (sidebar.contains(event.target) || toggleBtn.contains(event.target)) return;
      sidebar.classList.remove('open');
    });
  }

  /* ---------- Active nav link ---------- */

  var currentFile = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  document.querySelectorAll('.nav-link').forEach(function (link) {
    var href = (link.getAttribute('href') || '').toLowerCase();
    if (href === currentFile || (currentFile === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });

  /* ---------- Heading anchor links + on-page TOC ---------- */

  var content = document.querySelector('.content');
  var tocList = document.querySelector('.toc ul');

  if (content) {
    var headings = content.querySelectorAll('h2[id], h3[id]');
    headings.forEach(function (h) {
      var a = document.createElement('a');
      a.className = 'anchor-link';
      a.href = '#' + h.id;
      a.textContent = '#';
      h.appendChild(a);

      if (tocList) {
        var li = document.createElement('li');
        var link = document.createElement('a');
        link.href = '#' + h.id;
        link.textContent = h.textContent.replace(/#$/, '').trim();
        if (h.tagName === 'H3') link.className = 'sub';
        li.appendChild(link);
        tocList.appendChild(li);
      }
    });

    if (tocList && headings.length) {
      var tocLinks = Array.prototype.slice.call(tocList.querySelectorAll('a'));

      var setActive = function (id) {
        tocLinks.forEach(function (l) {
          l.classList.toggle('active', l.getAttribute('href') === '#' + id);
        });
      };

      if ('IntersectionObserver' in window) {
        var observer = new IntersectionObserver(
          function (entries) {
            var visible = entries.filter(function (e) { return e.isIntersecting; });
            if (visible.length) {
              setActive(visible[0].target.id);
            }
          },
          { rootMargin: '-10% 0px -70% 0px', threshold: [0, 1] },
        );
        headings.forEach(function (h) { observer.observe(h); });
      }
    } else if (tocList) {
      var tocWrap = document.querySelector('.toc');
      if (tocWrap) tocWrap.style.display = 'none';
    }
  }

  /* ---------- Code blocks: wrap, label, copy button, highlight ---------- */

  var LANG_LABELS = {
    json: 'JSON', powershell: 'PowerShell', bash: 'Shell', http: 'HTTP',
    env: 'Env', text: 'Text', javascript: 'JavaScript', plaintext: 'Text',
  };

  function highlight(code, lang) {
    var escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (lang === 'json') {
      escaped = escaped
        .replace(/(&quot;|"|&#39;)((?:\\.|[^"\\])*)\1(\s*:)/g, '<span class="tok-key">$1$2$1</span>$3')
        .replace(/:\s*(&quot;|"|&#39;)((?:\\.|[^"\\])*)\1/g, ': <span class="tok-str">$1$2$1</span>')
        .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="tok-num">$1</span>')
        .replace(/:\s*(true|false|null)/g, ': <span class="tok-bool">$1</span>');
    } else if (lang === 'powershell') {
      escaped = escaped
        .replace(/(#.*$)/gm, '<span class="tok-com">$1</span>')
        .replace(/(&quot;[^&]*?&quot;)/g, '<span class="tok-str">$1</span>')
        .replace(/\B(-[A-Za-z]+)\b/g, '<span class="tok-flag">$1</span>')
        .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '<span class="tok-var">$&</span>')
        .replace(/\b(Invoke-RestMethod|ConvertTo-Json|Set-Location|Copy-Item|docker|npm|npx|doppler)\b/g, '<span class="tok-kw">$1</span>');
    } else if (lang === 'bash') {
      escaped = escaped
        .replace(/(#.*$)/gm, '<span class="tok-com">$1</span>')
        .replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="tok-str">$1</span>')
        .replace(/\B(-{1,2}[A-Za-z][A-Za-z-]*)\b/g, '<span class="tok-flag">$1</span>')
        .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '<span class="tok-var">$&</span>')
        .replace(/\b(curl|docker|npm|npx|doppler|export)\b/g, '<span class="tok-kw">$1</span>');
    } else if (lang === 'env') {
      escaped = escaped
        .replace(/^([A-Z0-9_]+)(=)/gm, '<span class="tok-key">$1</span>$2')
        .replace(/(#.*$)/gm, '<span class="tok-com">$1</span>');
    } else if (lang === 'http') {
      escaped = escaped
        .replace(/^(GET|POST|PUT|DELETE|PATCH)/gm, '<span class="tok-kw">$1</span>')
        .replace(/^([A-Za-z-]+):/gm, '<span class="tok-key">$1</span>:');
    }
    return escaped;
  }

  document.querySelectorAll('pre code[class^="language-"]').forEach(function (codeEl) {
    var pre = codeEl.parentElement;
    if (pre.closest('.codeblock')) return;

    var lang = (codeEl.className.match(/language-(\w+)/) || [, 'text'])[1];
    var rawText = codeEl.textContent;

    var wrapper = document.createElement('div');
    wrapper.className = 'codeblock';

    var bar = document.createElement('div');
    bar.className = 'codebar';

    var label = document.createElement('span');
    label.className = 'lang';
    label.textContent = LANG_LABELS[lang] || lang;

    var uiStrings = window.SCRAPFORAI_UI || { copy: 'Copy', copied: 'Copied' };
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = uiStrings.copy;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(rawText).then(function () {
        btn.textContent = uiStrings.copied;
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = uiStrings.copy;
          btn.classList.remove('copied');
        }, 1400);
      });
    });

    bar.appendChild(label);
    bar.appendChild(btn);

    codeEl.innerHTML = highlight(rawText, lang);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(bar);
    wrapper.appendChild(pre);
  });

  /* ---------- Search ---------- */

  var overlay = document.querySelector('.search-overlay');
  var input = document.querySelector('.search-input-row input');
  var resultsBox = document.querySelector('.search-results');
  var openTriggers = document.querySelectorAll('[data-search-open]');
  var selIndex = -1;
  var currentResults = [];

  function openSearch() {
    if (!overlay) return;
    overlay.classList.add('open');
    input.value = '';
    renderResults('');
    setTimeout(function () { input.focus(); }, 10);
  }

  function closeSearch() {
    if (!overlay) return;
    overlay.classList.remove('open');
  }

  function renderResults(query) {
    var index = window.SCRAPFORAI_SEARCH_INDEX || [];
    query = query.trim().toLowerCase();
    var items;

    if (!query) {
      items = index.slice(0, 8);
    } else {
      items = index.filter(function (item) {
        return item.title.toLowerCase().indexOf(query) !== -1 ||
          (item.keywords || '').toLowerCase().indexOf(query) !== -1 ||
          (item.section || '').toLowerCase().indexOf(query) !== -1;
      }).slice(0, 25);
    }

    currentResults = items;
    selIndex = items.length ? 0 : -1;
    resultsBox.innerHTML = '';

    if (!items.length) {
      var noResultsLabel = (window.SCRAPFORAI_UI && window.SCRAPFORAI_UI.noResultsFor) || 'No results for';
      var empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = noResultsLabel + ' "' + query + '"';
      resultsBox.appendChild(empty);
      return;
    }

    items.forEach(function (item, i) {
      var a = document.createElement('a');
      a.className = 'search-result' + (i === 0 ? ' sel' : '');
      a.href = item.href;
      a.innerHTML = '<span class="sr-page">' + item.section + '</span><br><span class="sr-title">' + item.title + '</span>';
      resultsBox.appendChild(a);
    });
  }

  function moveSelection(delta) {
    var nodes = resultsBox.querySelectorAll('.search-result');
    if (!nodes.length) return;
    nodes[selIndex] && nodes[selIndex].classList.remove('sel');
    selIndex = (selIndex + delta + nodes.length) % nodes.length;
    nodes[selIndex].classList.add('sel');
    nodes[selIndex].scrollIntoView({ block: 'nearest' });
  }

  openTriggers.forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      openSearch();
    });
  });

  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSearch();
    });
  }

  if (input) {
    input.addEventListener('input', function () { renderResults(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var nodes = resultsBox.querySelectorAll('.search-result');
        if (nodes[selIndex]) window.location.href = nodes[selIndex].getAttribute('href');
      } else if (e.key === 'Escape') {
        closeSearch();
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    var isK = e.key === 'k' || e.key === 'K';
    if ((e.ctrlKey || e.metaKey) && isK) {
      e.preventDefault();
      overlay && overlay.classList.contains('open') ? closeSearch() : openSearch();
    } else if (e.key === 'Escape') {
      closeSearch();
    } else if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      openSearch();
    }
  });
})();
