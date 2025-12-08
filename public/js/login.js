const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!email || !password) {
    showError('Please enter both email and password.');
    return;
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showError(data.error || 'Invalid email or password.');
      return;
    }
    window.location.href = 'index.html';
  } catch (err) {
    console.error('Login failed', err);
    showError('Unable to login right now.');
  }
});
