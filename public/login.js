import { apiFetch } from './api.js';

const form = document.getElementById('login-form');
const input = document.getElementById('api-key');
const errorBox = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');

  try {
    await apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ apiKey: input.value }) });
    window.location.href = '/ui/index.html';
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
    input.value = '';
  }
});
