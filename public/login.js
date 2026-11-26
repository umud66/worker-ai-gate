const loginForm = document.getElementById('login-form');
const loginButton = document.getElementById('login-button');
const loginPassword = document.getElementById('login-password');
const loginMessage = document.getElementById('login-message');

async function authRequest(path, payload) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || '登录请求失败，请重试。');
  return result;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;
  loginButton.disabled = true;
  loginButton.textContent = '正在登录…';
  loginMessage.hidden = true;
  try {
    const key = CryptoJS.MD5(loginPassword.value);
    loginPassword.value = '';
    const { challenge } = await authRequest('challenge', {});
    const proof = CryptoJS.HmacSHA256(`stockwatch-login:${challenge}`, key).toString();
    await authRequest('login', { username: document.getElementById('login-user').value, challenge, proof });
    window.location.reload();
  } catch (error) {
    loginMessage.textContent = error.message;
    loginMessage.hidden = false;
    loginButton.disabled = false;
    loginButton.textContent = '登录';
    loginPassword.focus();
  }
});

if (typeof CryptoJS !== 'undefined') {
  loginButton.disabled = false;
} else {
  loginMessage.textContent = '无法加载登录组件，请刷新页面。';
  loginMessage.hidden = false;
}
