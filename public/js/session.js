(() => {
  const LOGIN_PAGE = /\/login\.html$/i.test(window.location.pathname);
  const AUTH_ENDPOINT = '/api/auth/me';

  function redirectToLogin() {
    if (!LOGIN_PAGE) {
      window.location.href = 'login.html';
    }
  }

  async function fetchCurrentUser() {
    const res = await fetch(AUTH_ENDPOINT, { credentials: 'include' });
    if (!res.ok) {
      throw new Error('unauthenticated');
    }
    const data = await res.json();
    if (!data || !data.user) {
      throw new Error('user missing');
    }
    return data.user;
  }

  function applyRoleVisibility(user) {
    const adminNav = document.getElementById('nav-admin');
    if (adminNav) {
      adminNav.classList.toggle('hidden', user.role !== 'admin');
    }

    document.querySelectorAll('[data-role-required]').forEach((el) => {
      const roles = (el.dataset.roleRequired || '')
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
      if (roles.length === 0) return;
      if (roles.includes(user.role)) {
        el.classList.remove('hidden');
        el.removeAttribute('aria-hidden');
      } else {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function updateUserBadge(user) {
    const pill = document.getElementById('user-pill');
    const nameEl = document.getElementById('user-name');
    const roleEl = document.getElementById('user-role');
    const logoutBtn = document.getElementById('logout-btn');

    if (pill && nameEl && roleEl) {
      // Keep the pill hidden per UX request; clear any placeholder text
      nameEl.textContent = '';
      roleEl.textContent = '';
      pill.classList.add('hidden');
    }

    if (logoutBtn) {
      logoutBtn.classList.remove('hidden');
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include'
        }).catch(() => {});
        window.location.href = 'login.html';
      });
    }
  }

  async function initSession() {
    try {
      const user = await fetchCurrentUser();
      window.currentUser = user;
      applyRoleVisibility(user);
      updateUserBadge(user);
      return user;
    } catch (err) {
      window.currentUser = null;
      redirectToLogin();
      throw err;
    }
  }

  if (!LOGIN_PAGE) {
    window.sessionReady = initSession();
  }

  window.requireRoles = function requireRoles(roles = []) {
    if (!Array.isArray(roles) || roles.length === 0) return;
    if (!window.sessionReady) {
      redirectToLogin();
      return;
    }
    window.sessionReady
      .then((user) => {
        if (!roles.includes(user.role)) {
          window.location.href = 'index.html';
        }
      })
      .catch(() => {});
  };
})();
