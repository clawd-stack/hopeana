/**
 * The one way the pages talk to the server. Nothing here holds a credential:
 * the session is an HttpOnly cookie the page cannot read.
 */
export const api = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : {},
      method: options.method ?? 'GET',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      keepalive: options.keepalive ?? false,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.message || 'Something went wrong. Please try again.');
      error.code = payload?.code || (response.status >= 500 ? 'INTERNAL' : 'NETWORK');
      error.status = response.status;
      error.detail = payload?.detail ?? null;
      throw error;
    }
    return payload;
  },
  get(path) { return this.request(path); },
  post(path, body = {}, options = {}) { return this.request(path, { method: 'POST', body, ...options }); },
  patch(path, body) { return this.request(path, { method: 'PATCH', body }); },
};
