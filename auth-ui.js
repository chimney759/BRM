(() => {
  const passwordInputs = new Set(['current-password', 'new-password', 'confirm-password', 'login-password']);

  function toggle(input, button) {
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.setAttribute('aria-pressed', String(!visible));
    button.setAttribute('aria-label', visible ? '查看密码' : '隐藏密码');
    button.title = visible ? '查看密码' : '隐藏密码';
    button.innerHTML = visible ? '&#128065;' : '&#9678;';
  }

  function decoratePassword(input) {
    if (!passwordInputs.has(input.id) || input.dataset.passwordToggleReady) return;
    input.dataset.passwordToggleReady = 'true';
    const shell = document.createElement('span');
    shell.className = 'password-control';
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    button.setAttribute('aria-label', '查看密码');
    button.setAttribute('aria-pressed', 'false');
    button.title = '查看密码';
    button.innerHTML = '&#128065;';
    button.addEventListener('click', () => toggle(input, button));
    shell.appendChild(button);
  }

  function sync() {
    document.querySelectorAll('input[type="password"]').forEach(decoratePassword);
    if (document.querySelector('.login-page')) {
      document.querySelector('#account-drawer')?.remove();
      document.querySelector('#modal')?.remove();
    }
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('#account-logout, #logout')) return;
    document.querySelector('#account-drawer')?.remove();
    document.querySelector('#modal')?.remove();
  }, true);

  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('brms:modal-rendered', sync);
  sync();
})();
