(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  var mailModal = $('mail-test-modal');
  var accountsModal = $('resend-accounts-modal');
  var listEl = $('resend-accounts-list');
  var hiddenFroms = $('resend-account-froms');
  var hiddenKeys = $('resend-account-keys');
  var primaryFrom = $('resend-primary-from');
  var primaryKey = $('resend-primary-key');
  var mailInput = $('mail-test-to');
  var KEEP = '__KEEP__';

  function splitLines(v) {
    return String(v || '').split(/\r?\n/);
  }

  function readAccountsFromHidden() {
    var froms = splitLines(hiddenFroms ? hiddenFroms.value : '');
    var keys = splitLines(hiddenKeys ? hiddenKeys.value : '');
    var rows = [];
    var n = Math.max(froms.length, keys.length, 1);
    for (var i = 0; i < n; i++) {
      var from = (froms[i] || '').trim();
      var key = (keys[i] || '').trim();
      if (!from && !key && i > 0) continue;
      rows.push({
        from: from,
        key: key === KEEP ? '' : key,
        keep: key === KEEP || (!key && !!from)
      });
    }
    if (rows.length === 0) rows.push({ from: '', key: '', keep: false });
    if (primaryFrom && primaryFrom.value) rows[0].from = primaryFrom.value;
    if (primaryKey && primaryKey.value) {
      rows[0].key = primaryKey.value;
      rows[0].keep = false;
    }
    return rows;
  }

  function collectAccounts() {
    if (!listEl) return [];
    var fromInputs = listEl.querySelectorAll('[data-from]');
    var keyInputs = listEl.querySelectorAll('[data-key]');
    var rows = [];
    for (var i = 0; i < fromInputs.length; i++) {
      var keyInput = keyInputs[i];
      var typed = keyInput ? String(keyInput.value || '') : '';
      var keep = !!(keyInput && keyInput.getAttribute('data-keep') === '1' && !typed.trim());
      rows.push({
        from: (fromInputs[i].value || '').trim(),
        key: typed,
        keep: keep
      });
    }
    return rows;
  }

  function renderAccounts(rows) {
    if (!listEl) return;
    listEl.innerHTML = '';
    rows.forEach(function (row, idx) {
      var card = document.createElement('div');
      card.className = 'rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3';
      var keyPlaceholder = row.keep ? '已配置（留空则保留原密钥）' : 're_xxxxxxxx';
      card.innerHTML =
        '<div class="flex items-center justify-between gap-2">' +
          '<div class="text-xs font-semibold text-slate-400">账号 #' + (idx + 1) + (idx === 0 ? '（主账号）' : '') + '</div>' +
          '<button type="button" data-remove="' + idx + '" class="text-xs text-rose-400 hover:text-rose-300 transition">删除</button>' +
        '</div>' +
        '<div>' +
          '<label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">发件邮箱</label>' +
          '<input data-from="' + idx + '" type="email" value="' + String(row.from || '').replace(/"/g, '&quot;') + '" placeholder="noreply@domain.com" class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500" />' +
        '</div>' +
        '<div>' +
          '<label class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">API Key</label>' +
          '<input data-key="' + idx + '" data-keep="' + (row.keep ? '1' : '0') + '" type="password" value="' + String(row.key || '').replace(/"/g, '&quot;') + '" placeholder="' + keyPlaceholder + '" class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono" />' +
        '</div>';
      listEl.appendChild(card);
    });

    listEl.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rowsNow = collectAccounts();
        var i = Number(btn.getAttribute('data-remove') || '0');
        rowsNow.splice(i, 1);
        if (rowsNow.length === 0) rowsNow = [{ from: '', key: '', keep: false }];
        renderAccounts(rowsNow);
      });
    });
  }

  function openMailTest(e) {
    if (e) e.preventDefault();
    openModal(mailModal);
    if (mailInput) {
      setTimeout(function () {
        mailInput.focus();
      }, 0);
    }
  }

  function openAccounts(e) {
    if (e) e.preventDefault();
    renderAccounts(readAccountsFromHidden());
    openModal(accountsModal);
  }

  function applyAccounts(e) {
    if (e) e.preventDefault();
    var rows = collectAccounts().filter(function (r) {
      return r.from || r.key || r.keep;
    });
    if (rows.length === 0) rows = [{ from: '', key: '', keep: false }];
    if (hiddenFroms) hiddenFroms.value = rows.map(function (r) { return r.from; }).join('\n');
    if (hiddenKeys) {
      hiddenKeys.value = rows.map(function (r) {
        var typed = (r.key || '').trim();
        if (typed) return typed;
        return r.keep ? KEEP : '';
      }).join('\n');
    }
    if (primaryFrom) primaryFrom.value = rows[0] ? rows[0].from : '';
    if (primaryKey) {
      var firstTyped = rows[0] ? String(rows[0].key || '').trim() : '';
      primaryKey.value = firstTyped || '';
      primaryKey.placeholder = (rows[0] && (rows[0].keep || firstTyped))
        ? '已配置（留空则不更新）'
        : 're_xxxxxxxx';
    }
    closeModal(accountsModal);
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    if (target.closest('#mail-test-open')) {
      openMailTest(e);
      return;
    }
    if (target.closest('#resend-accounts-open')) {
      openAccounts(e);
      return;
    }
    if (target.closest('#resend-account-add')) {
      e.preventDefault();
      var rows = collectAccounts();
      rows.push({ from: '', key: '', keep: false });
      renderAccounts(rows);
      return;
    }
    if (target.closest('#resend-accounts-apply')) {
      applyAccounts(e);
      return;
    }
    if (target.closest('#mail-test-backdrop') || target.closest('#mail-test-close') || target.closest('#mail-test-cancel')) {
      e.preventDefault();
      closeModal(mailModal);
      return;
    }
    if (target.closest('#resend-accounts-backdrop') || target.closest('#resend-accounts-close') || target.closest('#resend-accounts-cancel')) {
      e.preventDefault();
      closeModal(accountsModal);
      return;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (mailModal && !mailModal.classList.contains('hidden')) closeModal(mailModal);
    if (accountsModal && !accountsModal.classList.contains('hidden')) closeModal(accountsModal);
  });

  window.__adminMail = {
    openMailTest: openMailTest,
    openAccounts: openAccounts
  };
})();
