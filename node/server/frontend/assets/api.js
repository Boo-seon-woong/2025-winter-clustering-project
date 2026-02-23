(function () {
  function getToken() {
    return localStorage.getItem('token') || '';
  }

  function setToken(token) {
    localStorage.setItem('token', token);
  }

  function clearToken() {
    localStorage.removeItem('token');
  }

  async function request(path, method, body) {
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  window.Api = {
    getToken,
    setToken,
    clearToken,
    request
  };
})();
