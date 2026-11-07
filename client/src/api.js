// Which mailbox this page works on: the public ID from the URL (roammail.net/{id}/...). The server checks it
// belongs to one of this browser's signed-in mailboxes, or a shared mailbox they may open.
let mailboxId = '';
export const setMailboxId = (id) => { mailboxId = id || ''; };
export const currentMailboxId = () => mailboxId;
/** For URLs the browser opens directly (attachments, live updates): add ?mid= so the server picks the right mailbox. */
export const mailUrl = (url) => (mailboxId && url.startsWith('/api/') ? `${url}${url.includes('?') ? '&' : '?'}mid=${encodeURIComponent(mailboxId)}` : url);

async function request(method, url, body, { form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'mailcow-client' }, credentials: 'same-origin' };
  if (mailboxId && url.startsWith('/api/')) opts.headers['X-Mailbox-Id'] = mailboxId;
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 401 && !/\/login(\/2fa)?$/.test(url)) window.dispatchEvent(new Event('auth:expired'));
    if (res.status === 403 && (data?.code === '2fa_required' || data?.code === 'setup_required')) window.dispatchEvent(new Event('auth:2fa'));
    err.code = data?.code;
    throw err;
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const api = {
  get: (url, params) => request('GET', params ? `${url}?${qs(params)}` : url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url, params) => request('DELETE', params ? `${url}?${qs(params)}` : url),
  delWith: (url, body) => request('DELETE', url, body),
  form: (url, form) => request('POST', url, undefined, { form }),

  me: () => api.get('/api/me'),
  login: (email, password) => api.post('/api/login', { email, password }),
  logout: () => api.post('/api/logout'),
  signupConfig: () => api.get('/api/signup/config'),
  signup: (data) => api.post('/api/signup', data),

  folders: () => api.get('/api/folders'),
  messages: (folder, page, filter) => api.get('/api/messages', { folder, page, filter }),
  search: (q, folder) => api.get('/api/search', { q, folder }),
  thread: (folder, uid) => api.get('/api/thread', { folder, uid }),
  flags: (folder, uids, add = [], remove = []) => api.post('/api/flags', { folder, uids, add, remove }),
  move: (folder, uids, to) => api.post('/api/move', { folder, uids, to }),
  remove: (folder, uids, permanent) => api.post('/api/delete', { folder, uids, permanent }),
  contacts: (q) => api.get('/api/contacts', { q }),
  attachmentUrl: (folder, uid, index, inline) => mailUrl(`/api/attachment?${qs({ folder, uid, index, inline: inline ? 1 : '' })}`),
};
