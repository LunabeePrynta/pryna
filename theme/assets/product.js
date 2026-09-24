/* Lyra Kids — product page: variants, gallery, quantity, tabs, dialogs, share. */
(function () {
  'use strict';

  /* ── Money ── */
  function formatMoney(cents, format) {
    var fmt = format || '{{amount}}';
    function group(n, decimals, thousands, dec) {
      var parts = (n / 100).toFixed(decimals).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return parts.join(dec);
    }
    return fmt.replace(/\{\{\s*(\w+)\s*\}\}/, function (_, key) {
      switch (key) {
        case 'amount_no_decimals': return group(cents, 0, ',', '.');
        case 'amount_with_comma_separator': return group(cents, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return group(cents, 0, '.', ',');
        case 'amount_with_apostrophe_separator': return group(cents, 2, "'", '.');
        default: return group(cents, 2, ',', '.');
      }
    });
  }

  /* ── Gallery ── */
  function showMedia(root, id) {
    if (!id) return;
    var slide = root.querySelector('.pdp__slide[data-media-id="' + id + '"]');
    if (!slide) return;
    root.querySelectorAll('.pdp__slide').forEach(function (el) { el.classList.toggle('is-active', el === slide); });
    root.querySelectorAll('[data-thumb]').forEach(function (el) {
      var on = el.getAttribute('data-thumb') === String(id);
      el.classList.toggle('is-active', on);
      if (on) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  }

  function initGallery(root) {
    root.querySelectorAll('[data-thumb]').forEach(function (btn) {
      btn.addEventListener('click', function () { showMedia(root, btn.getAttribute('data-thumb')); });
    });
  }

  /* ── Variants ── */
  function initVariants(root) {
    var jsonEl = root.querySelector('[data-product-json]');
    var form = root.querySelector('[data-product-form]');
    if (!jsonEl || !form) return;
    var data = JSON.parse(jsonEl.textContent);
    var fieldsets = Array.prototype.slice.call(form.querySelectorAll('[data-option]'));
    var select = form.querySelector('[data-variant-select]');
    var add = form.querySelector('[data-add]');
    var price = root.querySelector('[data-price]');
    var compare = root.querySelector('[data-compare]');
    var badge = root.querySelector('[data-badge]');
    var stock = root.querySelector('[data-stock]');
    var sku = root.querySelector('[data-sku]');
    var skuRow = root.querySelector('[data-sku-row]');

    function selected() {
      return fieldsets.map(function (fs) {
        var checked = fs.querySelector('input:checked');
        return checked ? checked.value : null;
      });
    }

    function findVariant(opts) {
      for (var i = 0; i < data.variants.length; i++) {
        var v = data.variants[i];
        if (v.options.every(function (o, idx) { return o === opts[idx]; })) return v;
      }
      return null;
    }

    // Grey out values that have no available variant alongside the other current picks.
    function markAvailability(opts) {
      fieldsets.forEach(function (fs, idx) {
        fs.querySelectorAll('input').forEach(function (input) {
          var trial = opts.slice();
          trial[idx] = input.value;
          var ok = data.variants.some(function (v) {
            return v.available && v.options.every(function (o, j) { return o === trial[j]; });
          });
          input.parentElement.classList.toggle('is-na', !ok);
        });
      });
    }

    function update() {
      var opts = selected();
      fieldsets.forEach(function (fs, idx) {
        var label = fs.querySelector('[data-opt-value]');
        if (label) label.textContent = opts[idx] || '';
      });
      markAvailability(opts);

      var v = findVariant(opts);
      if (!v) {
        add.disabled = true;
        add.textContent = data.labels.unavailable;
        return;
      }

      select.value = v.id;
      add.disabled = !v.available;
      add.textContent = v.available ? data.labels.add : data.labels.soldOut;

      price.textContent = formatMoney(v.price, data.money);
      var onSale = v.compare > v.price;
      compare.hidden = !onSale;
      if (onSale) compare.textContent = formatMoney(v.compare, data.money);
      if (badge) {
        badge.hidden = !onSale;
        if (onSale) badge.textContent = '-' + Math.floor((v.compare - v.price) * 100 / v.compare) + '%';
      }

      if (stock) {
        var text = !v.available ? 'Sold out' : (v.qty && v.qty > 0 ? v.qty + ' in stock' : 'In stock');
        stock.innerHTML = '<span class="pdp__dot' + (v.available ? '' : ' is-out') + '"></span> ' + text;
      }
      if (sku) {
        sku.textContent = v.sku || '';
        skuRow.hidden = !v.sku;
      }

      showMedia(root, v.media);

      var url = new URL(window.location.href);
      url.searchParams.set('variant', v.id);
      window.history.replaceState({}, '', url.toString());
    }

    fieldsets.forEach(function (fs) { fs.addEventListener('change', update); });
    if (fieldsets.length) markAvailability(selected());
  }

  /* ── Quantity ── */
  function initQty(root) {
    root.querySelectorAll('[data-qty]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = btn.parentElement.querySelector('input');
        var next = Math.max(1, (parseInt(input.value, 10) || 1) + parseInt(btn.getAttribute('data-qty'), 10));
        input.value = next;
      });
    });
  }

  /* ── Dialogs ── */
  function initDialogs(root) {
    root.querySelectorAll('[data-dialog-open]').forEach(function (btn) {
      var dlg = document.getElementById(btn.getAttribute('data-dialog-open'));
      if (!dlg || typeof dlg.showModal !== 'function') return;
      btn.addEventListener('click', function () { dlg.showModal(); });
    });
    root.querySelectorAll('.pdp__dialog').forEach(function (dlg) {
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg || e.target.closest('[data-dialog-close]')) dlg.close();
      });
      if (dlg.querySelector('[data-dialog-autoopen]') && typeof dlg.showModal === 'function') dlg.showModal();
    });
  }

  /* ── Share ── */
  function initShare(root) {
    var btn = root.querySelector('[data-share]');
    if (!btn) return;
    var label = btn.querySelector('[data-share-label]');
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-url');
      if (navigator.share) {
        navigator.share({ title: btn.getAttribute('data-title'), url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          label.textContent = 'Link copied';
          setTimeout(function () { label.textContent = 'Share'; }, 2000);
        });
      }
    });
  }

  /* ── Tabs ── */
  function initTabs(wrap) {
    var tabs = Array.prototype.slice.call(wrap.querySelectorAll('[role="tab"]'));
    function activate(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { activate(tab); });
      tab.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) activate(tabs[(i + d + tabs.length) % tabs.length], true);
      });
    });
  }

  function init() {
    document.querySelectorAll('[data-pdp]').forEach(function (root) {
      initGallery(root);
      initVariants(root);
      initQty(root);
      initDialogs(root);
      initShare(root);
    });
    document.querySelectorAll('[data-tabs]').forEach(initTabs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
