const form = document.getElementById('loginForm');
const errorNode = document.getElementById('loginError');
const password = document.getElementById('password');
const toggle = document.getElementById('togglePassword');

toggle?.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  toggle.textContent = visible ? 'SHOW' : 'HIDE';
  toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorNode.textContent = '';
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.querySelector('span:first-child').textContent = 'Opening workspace…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Unable to sign in.');
    const destination = payload.redirect || (payload.user?.role === 'CUSTOMER' ? '/customer/portal' : '/app/overview');
    window.location.assign(destination);
  } catch (error) {
    errorNode.textContent = error.message || 'Connection error. Please try again.';
    submit.disabled = false;
    submit.querySelector('span:first-child').textContent = 'Enter workspace';
  }
});
