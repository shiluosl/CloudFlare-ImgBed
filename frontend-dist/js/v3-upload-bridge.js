(() => {
  'use strict';

  const currentUrl = new URL(window.location.href);
  // Cloudflare Assets may serve the SPA fallback before an extensionless Worker
  // route in local development. Redirect before Vue starts so the portal URL is
  // still reliable even when that fallback wins.
  if (currentUrl.pathname === '/v3-upload') {
    currentUrl.pathname = '/';
    currentUrl.searchParams.set('v3', '1');
    window.location.replace(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    return;
  }

  const v3Mode = currentUrl.searchParams.get('v3') === '1';
  if (!v3Mode) return;

  const V3_HEADER = 'X-V3-Legacy-UI';
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const requestState = new WeakMap();

  function requestUrl(value) {
    return new URL(String(value), window.location.origin);
  }

  function v3HomeUrl(value) {
    const url = requestUrl(value);
    if (url.origin !== window.location.origin || url.pathname !== '/' || url.search) return value;
    url.searchParams.set('v3', '1');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function rejectLegacyPath(url) {
    return url.pathname === '/api/fetchRes' || url.pathname === '/api/upload/huggingface';
  }

  XMLHttpRequest.prototype.open = function open(method, url, ...args) {
    const target = requestUrl(url);
    const isLegacyUpload = String(method).toUpperCase() === 'POST' && target.origin === window.location.origin && target.pathname === '/upload';

    if (rejectLegacyPath(target)) {
      throw new Error('V3 mode does not support legacy remote imports. Select a local file instead.');
    }
    if (isLegacyUpload) {
      if (target.searchParams.has('chunked') || target.searchParams.has('initChunked') || target.searchParams.has('cleanup')) {
        throw new Error('V3 uploads are limited to a single local file request.');
      }
      requestState.set(this, { v3Upload: true });
      return originalOpen.call(this, method, '/api/upload/v3', ...args);
    }
    return originalOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    if (requestState.get(this)?.v3Upload) {
      this.setRequestHeader(V3_HEADER, '1');
      this.setRequestHeader('Idempotency-Key', crypto.randomUUID());
    }
    return originalSend.call(this, body);
  };

  function keepV3Mode(original) {
    return function state(method, title, url) {
      return original.call(this, method, title, url === undefined || url === null ? url : v3HomeUrl(url));
    };
  }

  history.pushState = keepV3Mode(originalPushState);
  history.replaceState = keepV3Mode(originalReplaceState);

  const originalFetch = window.fetch.bind(window);
  window.fetch = function v3Fetch(input, init) {
    const target = requestUrl(input instanceof Request ? input.url : input);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (target.origin === window.location.origin && rejectLegacyPath(target)) {
      return Promise.reject(new Error('V3 mode blocks legacy remote imports.'));
    }
    if (target.origin !== window.location.origin && !['GET', 'HEAD'].includes(method)) {
      return Promise.reject(new Error('V3 mode blocks direct provider uploads.'));
    }
    return originalFetch(input, init);
  };
})();
