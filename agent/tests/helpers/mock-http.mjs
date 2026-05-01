/**
 * tests/helpers/mock-http.mjs — Mock HTTP req/res for unit testing
 */

/**
 * Create a mock HTTP request object.
 * @param {string} method - HTTP method
 * @param {string} url - Request URL
 * @param {object} [headers={}] - Request headers
 * @returns {object} Mock IncomingMessage
 */
export function createMockReq(method, url, headers = {}) {
  return {
    method,
    url,
    headers: { ...headers },
    connection: { remoteAddress: "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
    on(event, cb) { if (event === "end") setTimeout(cb, 0); },
  };
}

/**
 * Create a mock HTTP response object that captures status, headers, and body.
 * @returns {object} Mock ServerResponse with capture properties
 */
export function createMockRes() {
  const res = {
    _statusCode: null,
    _headers: {},
    _body: "",
    _ended: false,

    writeHead(statusCode, headers = {}) {
      res._statusCode = statusCode;
      Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key, value) {
      res._headers[key] = value;
      return res;
    },
    getHeader(key) {
      return res._headers[key];
    },
    end(body) {
      if (body) res._body += body;
      res._ended = true;
      return res;
    },
    write(chunk) {
      res._body += chunk;
      return true;
    },

    // EventEmitter stub — support res.on('finish', cb) etc.
    on(event, cb) {
      if (!res._listeners) res._listeners = {};
      if (!res._listeners[event]) res._listeners[event] = [];
      res._listeners[event].push(cb);
      return res;
    },
    emit(event, ...args) {
      if (res._listeners?.[event]) {
        for (const cb of res._listeners[event]) cb(...args);
      }
      return res;
    },

    // Convenience getters
    get statusCode() { return res._statusCode; },
    get body() {
      try { return JSON.parse(res._body); } catch { return res._body; }
    },
    get rawBody() { return res._body; },
    get ended() { return res._ended; },
  };
  return res;
}
