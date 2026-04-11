// Shared JWT auth helpers — included on every page
const API = '/api';

function getToken() { return localStorage.getItem('nexcart_token'); }
function setToken(t) { localStorage.setItem('nexcart_token', t); }
function clearToken() { localStorage.removeItem('nexcart_token'); }

function authHeaders() {
  const t = getToken();
  return t ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t } : { 'Content-Type': 'application/json' };
}

async function apiFetch(url, opts = {}) {
  const token = getToken();
  opts.headers = { ...(opts.headers || {}), ...(token ? { 'Authorization': 'Bearer ' + token } : {}) };
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(url, opts);
}

async function logout() {
  clearToken();
  window.location.href = '/';
}
