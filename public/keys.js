const get = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
let working = false;

function status(text, error = false) {
  get('status').textContent = text;
  get('status').hidden = !text;
  get('status').classList.toggle('error', error);
}

async function api(path, method = 'GET', input) {
  const response = await fetch(path, {
    method, cache: 'no-store',
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  if (response.status === 401) {
    window.location.reload();
    throw new Error('登录已过期');
  }
  if (response.status === 204) return;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || '请求失败');
  return result;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function list() {
  const { keys } = await api('/api/keys');
  get('keys').replaceChildren(...keys.map((item) => {
    const row = document.createElement('tr');
    const name = cell(item.name);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${item.prefix}… · ${item.created_at.slice(0, 10)}`;
    name.append(meta);
    const action = cell('已吊销');
    if (!item.revoked_at) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'quiet';
      revoke.textContent = '吊销';
      revoke.addEventListener('click', () => {
        if (!window.confirm(`吊销「${item.name}」？使用此密钥的客户端会失去访问权限。`)) return;
        mutate(revoke, () => api(`/api/keys/${item.id}/revoke`, 'POST', {}), () => status('密钥已吊销。'));
      });
      action.replaceChildren(revoke);
    }
    row.append(name, ...['requests', 'successes', 'input_tokens', 'output_tokens'].map((field) => cell(number.format(item[field]))), action);
    return row;
  }));
  get('key-table').hidden = !keys.length;
  get('empty').hidden = Boolean(keys.length);
  get('empty').textContent = '还没有 API Key。';
}

async function mutate(button, operation, ready) {
  if (working) return;
  working = true;
  button.disabled = true;
  status('');
  try {
    const data = await operation();
    ready(data);
    await list();
  } catch (error) {
    status(error.message, true);
  } finally {
    working = false;
    button.disabled = false;
  }
}

get('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  mutate(get('create'), () => api('/api/keys', 'POST', { name: get('key-name').value }), (item) => {
    get('key-name').value = '';
    get('reveal-value').value = item.key;
    get('key-reveal').hidden = false;
    get('reveal-value').select();
  });
});
get('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(get('reveal-value').value);
    status('已复制 API Key。');
  } catch {
    get('reveal-value').select();
    status('请手动复制选中的 API Key。');
  }
});
get('hide-key').addEventListener('click', () => {
  get('reveal-value').value = '';
  get('key-reveal').hidden = true;
});
get('logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', 'POST', {});
    window.location.reload();
  } catch (error) {
    status(error.message, true);
  }
});
get('refresh-keys').addEventListener('click', () => list().catch((error) => status(error.message, true)));
list().catch((error) => { get('empty').hidden = true; status(error.message, true); });
