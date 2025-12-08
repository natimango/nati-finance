const USERS_API = '/api/auth/users';

if (window.requireRoles) {
  window.requireRoles(['admin']);
}

document.addEventListener('DOMContentLoaded', () => {
  if (!window.sessionReady) {
    return;
  }
  window.sessionReady
    .then((user) => {
      if (!user || user.role !== 'admin') {
        window.location.href = 'index.html';
        return;
      }
      initAdminPage();
    })
    .catch(() => {});
});

function initAdminPage() {
  const form = document.getElementById('create-user-form');
  if (form) {
    form.addEventListener('submit', handleCreateUser);
  }
  loadUsers();
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadUsers() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500 text-sm">Loading users…</td></tr>`;
  try {
    const res = await fetch(USERS_API, { credentials: 'include' });
    if (!res.ok) throw new Error('Unable to load users');
    const data = await res.json();
    const users = data.users || [];
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500 text-sm">No users found.</td></tr>`;
      return;
    }
    tbody.innerHTML = users
      .map((user) => {
        const safeEmail = escapeHtml(user.email);
        const safeName = escapeHtml(user.name || user.email);
        return `
          <tr>
            <td class="px-4 py-3">
              <p class="font-semibold">${safeName}</p>
              <p class="text-xs text-slate-500">${safeEmail}</p>
            </td>
            <td class="px-4 py-3 text-sm font-semibold">${user.role.toUpperCase()}</td>
            <td class="px-4 py-3 text-sm text-slate-600">${formatDateTime(user.created_at)}</td>
            <td class="px-4 py-3 text-sm text-slate-600">${user.last_login ? formatDateTime(user.last_login) : '—'}</td>
            <td class="px-4 py-3 text-right">
              <button class="px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 hover:border-rose-400 hover:text-rose-600 transition"
                onclick="deleteUser(${user.id}, '${safeEmail}')">
                <i class="fas fa-trash mr-1"></i>Remove
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load users', err);
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-rose-500 text-sm">${err.message || 'Failed to load users'}</td></tr>`;
  }
}

async function handleCreateUser(event) {
  event.preventDefault();
  const messageEl = document.getElementById('create-user-message');
  if (messageEl) {
    messageEl.textContent = '';
  }
  const email = document.getElementById('new-user-email').value.trim().toLowerCase();
  const password = document.getElementById('new-user-password').value.trim();
  const fullName = document.getElementById('new-user-name').value.trim();
  const role = document.getElementById('new-user-role').value;

  if (!email || !password || !role) {
    showCreateMessage('Email, password and role are required.', 'error');
    return;
  }

  try {
    const res = await fetch(USERS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        email,
        password,
        role,
        full_name: fullName || null
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Unable to create user');
    }
    showCreateMessage(`Created user ${email}`, 'success');
    document.getElementById('create-user-form').reset();
    loadUsers();
  } catch (err) {
    console.error('Create user failed', err);
    showCreateMessage(err.message || 'Unable to create user', 'error');
  }
}

function showCreateMessage(text, tone = 'muted') {
  const messageEl = document.getElementById('create-user-message');
  if (!messageEl) return;
  const toneClass =
    tone === 'error'
      ? 'text-rose-600'
      : tone === 'success'
      ? 'text-emerald-600'
      : 'text-slate-500';
  messageEl.textContent = text;
  messageEl.className = `text-sm ${toneClass}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return value;
  }
}

window.deleteUser = async function deleteUser(userId, email) {
  if (!userId) return;
  const confirmed = confirm(`Remove user "${email}"? Their uploads will stay but ownership will clear.`);
  if (!confirmed) return;
  try {
    const res = await fetch(`${USERS_API}/${userId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to delete user');
    }
    loadUsers();
  } catch (err) {
    console.error('Delete user failed', err);
    alert(err.message || 'Unable to delete user');
  }
};
