/* DocSpace published-site client. Vanilla JS, no external requests besides this server. */
(function () {
  'use strict';
  var cfgEl = document.getElementById('ds-config');
  var cfg = cfgEl ? JSON.parse(cfgEl.textContent) : { features: {} };
  var api = '/api/public/sites/' + cfg.spaceId;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'docspace' }, body: JSON.stringify(body) });
  }

  // ---- Theme mode -------------------------------------------------------------------------
  var modeBtn = $('.mode-btn');
  if (modeBtn) modeBtn.addEventListener('click', function () {
    var dark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('ds-mode', dark ? 'dark' : 'light'); } catch (e) {}
    renderMermaid(true);
  });

  // ---- Navigation ---------------------------------------------------------------------------
  var menuBtn = $('.menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', function () { document.body.classList.add('nav-open'); });
  var backdrop = $('.sidebar-backdrop');
  if (backdrop) backdrop.addEventListener('click', function () { document.body.classList.remove('nav-open'); });
  $$('.nav-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var li = btn.closest('.nav-parent');
      var open = li.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });
  var activeLink = $('.nav-link.active');
  if (activeLink && activeLink.scrollIntoView) activeLink.scrollIntoView({ block: 'center' });

  // ---- Copy buttons -------------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.copy-btn');
    if (!btn) return;
    var box = btn.closest('.code-block, .try-curl');
    var code = box && box.querySelector('pre code');
    if (!code) return;
    navigator.clipboard.writeText(code.innerText).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
  });

  // ---- Tabs ---------------------------------------------------------------------------------
  $$('.tabs').forEach(function (tabs) {
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn || btn.closest('.tabs') !== tabs) return;
      var idx = btn.getAttribute('data-tab');
      $$(':scope > .tab-list > .tab-btn', tabs).forEach(function (b) { b.classList.toggle('active', b === btn); });
      $$(':scope > .tab-panel', tabs).forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === idx); });
    });
  });

  // ---- Table of contents highlight -------------------------------------------------------
  var tocLinks = $$('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    tocLinks.forEach(function (a) { map[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
    var visible = {};
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var first = tocLinks.map(function (a) { return decodeURIComponent(a.getAttribute('href').slice(1)); }).filter(function (id) { return visible[id]; })[0];
      if (first) tocLinks.forEach(function (a) { a.classList.toggle('active', a === map[first]); });
    }, { rootMargin: '-60px 0px -60% 0px' });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) obs.observe(el); });
  }

  // ---- Mermaid diagrams (served locally) ----------------------------------------------------
  var mermaidLoading = null;
  function renderMermaid(rerender) {
    var blocks = $$('pre.mermaid');
    if (!blocks.length) return;
    if (!mermaidLoading) {
      blocks.forEach(function (b) { b.setAttribute('data-src', b.textContent); });
      mermaidLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/_site/mermaid.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    mermaidLoading.then(function () {
      var dark = document.documentElement.classList.contains('dark');
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
      if (rerender) blocks.forEach(function (b) { b.removeAttribute('data-processed'); b.textContent = b.getAttribute('data-src'); });
      window.mermaid.run({ nodes: blocks }).catch(function () {});
    });
  }
  renderMermaid(false);

  // ---- Feedback -----------------------------------------------------------------------------
  var fb = $('[data-feedback]');
  if (fb) {
    var rating = 0;
    var form = $('.feedback-form', fb);
    $$('button[data-rating]', fb).forEach(function (b) {
      b.addEventListener('click', function () {
        rating = Number(b.getAttribute('data-rating'));
        $$('button[data-rating]', fb).forEach(function (x) { x.classList.toggle('selected', x === b); });
        post(api + '/feedback', { pageId: cfg.pageId, rating: rating });
        form.hidden = false;
        $('textarea', form).focus();
      });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var comment = $('textarea', form).value.trim();
      if (comment) post(api + '/feedback', { pageId: cfg.pageId, rating: rating, comment: comment });
      form.hidden = true;
      $('.feedback-thanks', fb).hidden = false;
    });
  }

  // ---- Minimal Markdown renderer for AI answers ---------------------------------------------
  function md(text, sources) {
    var blocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, function (_m, _l, code) { blocks.push('<pre><code>' + esc(code) + '</code></pre>'); return '\u0000' + (blocks.length - 1) + '\u0000'; });
    var html = esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d+)\]/g, function (m, n) { var s = sources[Number(n) - 1]; return s ? '<a href="' + esc(s.url) + '" title="' + esc(s.title) + '">[' + n + ']</a>' : m; });
    var out = [];
    var list = null;
    html.split('\n').forEach(function (line) {
      var li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) { if (!list) { list = []; } list.push('<li>' + li[1] + '</li>'); return; }
      if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
      if (/^&gt;\s?/.test(line)) { out.push('<blockquote>' + line.replace(/^&gt;\s?/, '') + '</blockquote>'); return; }
      var h = /^#{1,4}\s+(.*)$/.exec(line);
      if (h) { out.push('<p><strong>' + h[1] + '</strong></p>'); return; }
      if (line.trim()) out.push('<p>' + line + '</p>');
    });
    if (list) out.push('<ul>' + list.join('') + '</ul>');
    return out.join('').replace(/\u0000(\d+)\u0000/g, function (_m, i) { return blocks[Number(i)]; });
  }

  // ---- Search + Ask AI ------------------------------------------------------------------------
  var modal = $('#search-modal');
  if (modal) {
    var input = $('input', modal);
    var results = $('.search-results', modal);
    var askBtn = $('.ask-ai', modal);
    var answer = $('.ai-answer', modal);
    var active = -1;
    var timer = null;
    var history = [];
    var open = function () { modal.hidden = false; input.focus(); input.select(); };
    var close = function () { modal.hidden = true; };
    $$('.search-btn').forEach(function (b) { b.addEventListener('click', open); });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); modal.hidden ? open() : close(); }
      else if (e.key === '/' && modal.hidden && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); open(); }
      else if (e.key === 'Escape' && !modal.hidden) close();
    });

    var items = function () { return $$('.result, .ask-ai:not([hidden])', modal); };
    var setActive = function (i) {
      var list = items();
      if (!list.length) return;
      active = (i + list.length) % list.length;
      list.forEach(function (el, j) { el.classList.toggle('active', j === active); });
      list[active].scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var list = items();
        if (active >= 0 && list[active]) list[active].click();
        else if (askBtn && input.value.trim()) ask(input.value.trim());
        else if (list[0]) list[0].click();
      }
    });

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      answer.hidden = true;
      if (askBtn) {
        askBtn.hidden = !q;
        $('.ask-label', askBtn).textContent = 'Ask the assistant: “' + q + '”';
      }
      if (!q) { results.innerHTML = ''; return; }
      timer = setTimeout(function () {
        fetch(api + '/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (input.value.trim() !== q) return;
            active = -1;
            if (!data.results || !data.results.length) {
              results.innerHTML = '<div class="result-empty">No results for "' + esc(q) + '"' + (askBtn ? '. Try asking the assistant.' : '') + '</div>';
              return;
            }
            results.innerHTML = data.results.map(function (r) {
              var href = (cfg.base || '') + '/' + r.path + (r.anchor ? '#' + r.anchor : '');
              return '<a class="result" href="' + esc(href) + '"><div class="result-title">' + esc(r.title) + (r.heading ? ' <span class="result-heading">› ' + esc(r.heading) + '</span>' : '') + '</div><div class="result-snippet">' + esc(r.snippet) + '</div></a>';
            }).join('');
          })
          .catch(function () {});
      }, 160);
    });

    if (askBtn) askBtn.addEventListener('click', function () { ask(input.value.trim()); });

    function ask(question) {
      if (!question) return;
      results.innerHTML = '';
      if (askBtn) askBtn.hidden = true;
      answer.hidden = false;
      var sources = [];
      answer.innerHTML = '<div class="ai-q">' + esc(question) + '</div><div class="ai-body typing"></div><div class="ai-sources"></div>';
      var body = $('.ai-body', answer);
      var text = '';
      post(api + '/ask', { question: question, history: history }).then(function (res) {
        if (!res.ok || !res.body) throw new Error('failed');
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return finish();
            buf += decoder.decode(r.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (p) {
              var line = p.replace(/^data:\s*/, '');
              if (!line) return;
              try {
                var ev = JSON.parse(line);
                if (ev.type === 'sources') {
                  sources = ev.sources.map(function (s) { return { title: s.title + (s.heading ? ' › ' + s.heading : ''), url: (cfg.base || '') + '/' + s.path + (s.anchor ? '#' + s.anchor : '') }; });
                } else if (ev.type === 'delta') {
                  text += ev.text;
                  body.innerHTML = md(text, sources);
                } else if (ev.type === 'error') {
                  text += '\n\n' + ev.message;
                  body.innerHTML = md(text, sources);
                }
              } catch (e) {}
            });
            return pump();
          });
        }
        return pump();
      }).catch(function () {
        body.innerHTML = '<p>Sorry, the assistant is unavailable right now.</p>';
        finish();
      });
      function finish() {
        body.classList.remove('typing');
        history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
        history = history.slice(-6);
        $('.ai-sources', answer).innerHTML = sources.map(function (s, i) { return '<a href="' + esc(s.url) + '">[' + (i + 1) + '] ' + esc(s.title) + '</a>'; }).join('');
        var fu = document.createElement('form');
        fu.className = 'ai-followup';
        fu.innerHTML = '<input placeholder="Ask a follow-up…" aria-label="Follow-up question"><button type="submit">Ask</button>';
        fu.addEventListener('submit', function (e) { e.preventDefault(); var v = $('input', fu).value.trim(); if (v) ask(v); });
        answer.appendChild(fu);
        var note = document.createElement('div');
        note.className = 'ai-note';
        note.textContent = cfg.features.aiLlm ? 'Answers are generated from this documentation and may contain mistakes. Check the linked sources.' : 'Answer compiled from the most relevant passages in this documentation.';
        answer.appendChild(note);
      }
    }
  }

  // ---- API playground -----------------------------------------------------------------------
  $$('[data-playground]').forEach(function (pg) {
    var data = JSON.parse($('.api-data', pg).textContent);
    var bodyEl = $('.try-body', pg);
    var fields = [];
    data.security.forEach(function (s) {
      var label = s.type === 'http' && s.scheme === 'bearer' ? 'Authorization (Bearer token)' : s.type === 'apiKey' ? s.name + ' (' + s.in + ')' : s.name;
      fields.push({ key: 'auth:' + s.name, label: label, sec: s });
    });
    data.parameters.forEach(function (p) {
      fields.push({ key: p.in + ':' + p.name, label: p.name + ' (' + p.in + ')' + (p.required ? ' *' : ''), param: p });
    });
    var html = fields.map(function (f) {
      var val = f.param ? f.param.example : '';
      var stored = '';
      try { stored = f.sec ? sessionStorage.getItem('ds-auth-' + f.sec.name) || '' : ''; } catch (e) {}
      return '<div class="try-field"><label>' + esc(f.label) + '</label><input data-key="' + esc(f.key) + '" value="' + esc(stored || (val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : val)) + '"' + (f.sec ? ' type="password" autocomplete="off"' : '') + '></div>';
    }).join('');
    if (data.bodyType) {
      html += '<div class="try-field"><label>Body (' + esc(data.bodyType) + ')</label><textarea data-key="body" spellcheck="false">' + esc(data.bodyExample != null ? JSON.stringify(data.bodyExample, null, 2) : '') + '</textarea></div>';
    }
    html += '<label class="try-proxy"><input type="checkbox" data-key="proxy"> Send through docs server (avoids CORS)</label>';
    bodyEl.innerHTML = html;
    var serverSel = $('.try-server', pg);
    var curlEl = $('.try-curl code', pg);

    function build() {
      var url = (serverSel.value || '') + data.path;
      var headers = {};
      var query = [];
      $$('input[data-key], textarea[data-key]', bodyEl).forEach(function (el) {
        var key = el.getAttribute('data-key');
        if (key === 'proxy' || key === 'body') return;
        var v = el.value;
        var parts = key.split(':');
        var where = parts[0], name = parts.slice(1).join(':');
        if (where === 'auth') {
          var sec = data.security.filter(function (s) { return s.name === name; })[0];
          try { sessionStorage.setItem('ds-auth-' + name, v); } catch (e) {}
          if (!v || !sec) return;
          if (sec.type === 'http' && sec.scheme === 'bearer') headers['Authorization'] = 'Bearer ' + v;
          else if (sec.type === 'http' && sec.scheme === 'basic') headers['Authorization'] = 'Basic ' + btoa(v);
          else if (sec.type === 'apiKey' && sec.in === 'header') headers[sec.name] = v;
          else if (sec.type === 'apiKey' && sec.in === 'query') query.push(encodeURIComponent(sec.name) + '=' + encodeURIComponent(v));
          else if (sec.type === 'oauth2' || sec.type === 'openIdConnect') headers['Authorization'] = 'Bearer ' + v;
          return;
        }
        if (v === '') return;
        if (where === 'path') url = url.replace('{' + name + '}', encodeURIComponent(v));
        else if (where === 'query') query.push(encodeURIComponent(name) + '=' + encodeURIComponent(v));
        else if (where === 'header') headers[name] = v;
      });
      if (query.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + query.join('&');
      var bodyField = $('textarea[data-key="body"]', bodyEl);
      var body = bodyField && bodyField.value.trim() ? bodyField.value : null;
      if (body) headers['Content-Type'] = data.bodyType;
      return { url: url, method: data.method.toUpperCase(), headers: headers, body: body };
    }
    function updateCurl() {
      var r = build();
      var lines = ['curl -X ' + r.method + " '" + r.url + "'"];
      Object.keys(r.headers).forEach(function (h) { lines.push("  -H '" + h + ': ' + (h === 'Authorization' ? r.headers[h].replace(/ .+$/, ' <token>') : r.headers[h]) + "'"); });
      if (r.body) lines.push("  --data '" + r.body.replace(/'/g, "'\\''") + "'");
      curlEl.textContent = lines.join(' \\\n');
    }
    bodyEl.addEventListener('input', updateCurl);
    serverSel.addEventListener('change', updateCurl);
    updateCurl();

    $('.try-send', pg).addEventListener('click', function () {
      var r = build();
      var btn = this;
      var out = $('.try-response', pg);
      var useProxy = $('input[data-key="proxy"]', bodyEl).checked;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      var started = performance.now();
      var req = useProxy
        ? post(api + '/playground', r).then(function (res) { return res.json(); })
        : fetch(r.url, { method: r.method, headers: r.headers, body: r.method === 'GET' || r.method === 'HEAD' ? undefined : r.body }).then(function (res) {
            return res.text().then(function (t) { return { status: res.status, statusText: res.statusText, body: t }; });
          });
      req.then(function (res) {
        var ms = Math.round(performance.now() - started);
        var body = res.body;
        try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (e) {}
        out.hidden = false;
        $('.try-status', out).innerHTML = '<span class="status ' + (res.status < 300 ? 'status-ok' : 'status-err') + '">' + esc(res.status) + '</span> ' + esc(res.statusText || '') + ' · ' + ms + ' ms';
        $('pre code', out).textContent = res.error || body || '(empty response)';
        post(api + '/events', { type: 'api_call', pageId: cfg.pageId, meta: { method: r.method, path: data.path, status: res.status } });
      }).catch(function (err) {
        out.hidden = false;
        $('.try-status', out).innerHTML = '<span class="status status-err">Error</span>';
        $('pre code', out).textContent = String(err && err.message || err) + '\n\nThe API may not allow cross-origin requests from this site. Enable "Send through docs server".';
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = 'Send request';
      });
    });
  });
})();
