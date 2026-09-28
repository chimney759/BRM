(() => {
  const config = Object.freeze({
    mode: 'http',
    apiBaseUrl: String(window.BRMS_CONFIG?.apiBaseUrl || '/api').replace(/\/$/, ''),
    localAuth: window.BRMS_CONFIG?.localAuth === true
  });
  const unwrap = (payload) => payload?.data ?? payload;
  const normalizeError = async (response) => {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || `请求失败（${response.status}）`);
    error.code = body.code || (response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED');
    error.details = body.details;
    throw error;
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`${config.apiBaseUrl}${path}`, {
      credentials: config.localAuth ? 'omit' : 'include',
      headers: { Accept: 'application/json', ...(config.localAuth ? { 'X-BRMS-Demo-Role': localStorage.getItem('brms-local-api-role') || 'requester', ...(localStorage.getItem('brms-local-api-user-id') ? { 'X-BRMS-Demo-User-Id': localStorage.getItem('brms-local-api-user-id') } : {}) } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      ...options
    });
    if (!response.ok) return normalizeError(response);
    if (response.status === 204) return null;
    return unwrap(await response.json());
  };
  const query = (filters = {}) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      (Array.isArray(value) ? value : [value]).filter(Boolean).forEach((item) => params.append(key, item));
    });
    return params.toString() ? `?${params}` : '';
  };
  const listData = (value) => Array.isArray(value) ? value : (value.items || []);

  const http = {
    requirements: {
      async list(filters = {}) { return listData(await request(`/requirements${query(filters)}`)); },
      async get(id) { return request(`/requirements/${encodeURIComponent(id)}`); },
      async create(item) { return request('/requirements', { method: 'POST', body: JSON.stringify(item) }); },
      async save(item) { return request(`/requirements/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ ...item, updatedAt: item.updatedAt }) }); },
      async action(id, action) { const { record, ...payload } = action; return request(`/requirements/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify(payload) }); },
      async quickRelease(payload) { return request('/requirements/quick-release', { method: 'POST', body: JSON.stringify(payload) }); }
    },
    uploads: { async image(dataUrl) { return request('/uploads/images', { method: 'POST', body: JSON.stringify({ dataUrl }) }); } },
    projects: {
      async list(filters = {}) { return listData(await request(`/projects${query(filters)}`)); },
      async get(id) { return request(`/projects/${encodeURIComponent(id)}`); },
      async save(item) { return item.id ? request(`/projects/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify(item) }) : request('/projects', { method: 'POST', body: JSON.stringify(item) }); },
      async remove(id) { return request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    },
    users: {
      async list(filters = {}) { return listData(await request(`/users${query(filters)}`)); },
      async save(item) { return item.id ? request(`/users/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify(item) }) : request('/users', { method: 'POST', body: JSON.stringify(item) }); },
      async resetPassword(id) { return request(`/users/${encodeURIComponent(id)}/password-reset`, { method: 'POST' }); },
      async remove(id) { return request(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
      async find(name) { return (await this.list({ keyword: name, status: '启用' })).find((item) => item.name === name); }
    },
    versions: {
      async list(filters = {}) { return listData(await request(`/project-versions${query(filters)}`)); },
      async get(id) { return request(`/project-versions/${encodeURIComponent(id)}`); },
      async save(item) { return item.id ? request(`/project-versions/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify(item) }) : request('/project-versions', { method: 'POST', body: JSON.stringify(item) }); },
      async remove(id) { return request(`/project-versions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    },
    workbench: { async get(filters = {}) { return request(`/workbench${query(filters)}`); } },
    messages: { async list(filters = {}) { return listData(await request(`/messages${query(filters)}`)); } },
    activities: { async list(filters = {}) { return listData(await request(`/requirement-activities${query(filters)}`)); }, async markRead(requirementId) { return request(`/requirement-activities/${encodeURIComponent(requirementId)}/read`, { method: 'POST' }); }, async markAllRead() { return request('/requirement-activities/read-all', { method: 'POST' }); } },
    archives: { async list(filters = {}) { return request(`/archives${query(filters)}`); } },
    auth: { async user() { return request('/me'); }, async set(role, userId = '') { if (!config.localAuth) throw Error('生产环境的身份由企业登录服务决定，不能在浏览器切换'); localStorage.setItem('brms-local-api-role', role); if (userId) localStorage.setItem('brms-local-api-user-id', userId); else localStorage.removeItem('brms-local-api-user-id'); } }
  };
  window.BRMS = Object.freeze({ mode: config.mode, config, repo: http, isLocal: false, localRoleSwitch: config.localAuth });
})();
