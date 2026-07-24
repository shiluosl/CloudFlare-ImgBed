/**
 * WebDAV API helper
 *
 * Uses only Fetch/Web APIs so it works in Cloudflare Pages Functions,
 * Cloudflare Workers, and the local Node-based test/runtime paths.
 */
import { assertExternalEndpoint } from '../../core/security/endpointValidation.js';

const MAX_READ_REDIRECTS = 2;
const MAX_READ_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 150;

export class WebDAVAPI {
    constructor(config = {}) {
        const baseUrl = config.baseUrl;
        if (!baseUrl) {
            throw new Error('WebDAV baseUrl is required');
        }

        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.username = config.username || '';
        this.password = config.password || '';
        this.headers = normalizeHeaders(config.headers || {});
        this.createDirectory = config.createDirectory !== false;
    }

    buildObjectUrl(path) {
        return buildWebDAVUrl(this.baseUrl, path);
    }

    buildPublicUrl(path, publicUrl = '') {
        if (!publicUrl) return '';
        return buildWebDAVUrl(normalizeBaseUrl(publicUrl), path);
    }

    getRequestHeaders(extraHeaders = {}) {
        const headers = new Headers(this.headers);

        if ((this.username || this.password) && !headers.has('Authorization')) {
            headers.set('Authorization', `Basic ${base64EncodeUtf8(`${this.username}:${this.password}`)}`);
        }

        for (const [key, value] of Object.entries(extraHeaders || {})) {
            if (value !== undefined && value !== null && value !== '') {
                headers.set(key, value);
            }
        }

        return headers;
    }

    async ensureDirectory(path) {
        if (!this.createDirectory) return;

        const dirParts = getDirectoryParts(path);
        if (dirParts.length === 0) return;

        let currentPath = '';
        for (const part of dirParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const response = await fetch(this.buildObjectUrl(currentPath), {
                method: 'MKCOL',
                headers: this.getRequestHeaders(),
                redirect: 'manual',
            });

            // 405 commonly means the collection already exists. Some servers return 200/204.
            if (![200, 201, 204, 405].includes(response.status)) {
                throw new Error(`WebDAV MKCOL failed for ${currentPath}: ${response.status} ${response.statusText}`);
            }
        }
    }

    async putFile(path, body, contentType = '') {
        await this.ensureDirectory(path);

        const headers = this.getRequestHeaders(contentType ? { 'Content-Type': contentType } : {});
        const response = await fetch(this.buildObjectUrl(path), {
            method: 'PUT',
            headers,
            body,
            redirect: 'manual',
        });

        if (!isSuccessStatus(response.status)) {
            const detail = await safeReadResponseText(response);
            throw new Error(`WebDAV PUT failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
        }

        return response;
    }

    async getFile(path, options = {}) {
        const method = options.method || 'GET';
        const response = await fetchWebDAVRead(this.buildObjectUrl(path), {
            method,
            headers: this.getRequestHeaders(options.headers || {}),
            redirect: 'manual',
        });

        if (!isSuccessStatus(response.status) && response.status !== 304) {
            const detail = await safeReadResponseText(response);
            throw new Error(`WebDAV ${options.method || 'GET'} failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
        }

        return response;
    }

    async moveFile(oldPath, newPath, overwrite = true) {
        await this.ensureDirectory(newPath);

        const response = await fetch(this.buildObjectUrl(oldPath), {
            method: 'MOVE',
            headers: this.getRequestHeaders({
                Destination: this.buildObjectUrl(newPath),
                Overwrite: overwrite ? 'T' : 'F',
            }),
            redirect: 'manual',
        });

        if (!isSuccessStatus(response.status)) {
            const detail = await safeReadResponseText(response);
            throw new Error(`WebDAV MOVE failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
        }

        return true;
    }

    async deleteFile(path) {
        const response = await fetch(this.buildObjectUrl(path), {
            method: 'DELETE',
            headers: this.getRequestHeaders(),
            redirect: 'manual',
        });

        // DELETE is idempotent for app semantics; a missing remote object should not block DB cleanup.
        if (response.status === 404) return true;

        if (!isSuccessStatus(response.status)) {
            const detail = await safeReadResponseText(response);
            throw new Error(`WebDAV DELETE failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
        }

        return true;
    }
}

// Some WebDAV providers return a short-lived public download URL for reads.
// Follow only a small, validated HTTPS redirect chain and never forward WebDAV
// credentials to the download host.
export async function fetchWebDAVRead(url, init = {}, fetchImpl = fetch) {
    const method = String(init.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
        return fetchImpl(url, { ...init, redirect: 'manual' });
    }

    let lastError;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        try {
            const response = await followWebDAVReadRedirects(url, init, method, fetchImpl);
            if (!isRetriableReadResponse(response) || attempt === MAX_READ_ATTEMPTS - 1) {
                return response;
            }

            await discardResponseBody(response);
        } catch (error) {
            lastError = error;
            if (attempt === MAX_READ_ATTEMPTS - 1) {
                throw error;
            }
        }

        await delay(READ_RETRY_DELAY_MS);
    }

    throw lastError || new Error('WebDAV read failed');
}

async function followWebDAVReadRedirects(url, init, method, fetchImpl) {
    let currentUrl = String(url);
    let headers = new Headers(init.headers || {});
    for (let redirectCount = 0; redirectCount <= MAX_READ_REDIRECTS; redirectCount += 1) {
        const response = await fetchImpl(currentUrl, {
            ...init,
            method,
            headers,
            redirect: 'manual',
        });
        if (response.status < 300 || response.status >= 400) {
            return response;
        }

        const location = response.headers.get('Location');
        if (!location || redirectCount === MAX_READ_REDIRECTS) {
            throw new Error('WebDAV read redirect rejected');
        }

        let redirectUrl;
        try {
            redirectUrl = new URL(location, currentUrl);
            assertExternalEndpoint(redirectUrl, { label: 'WebDAV download redirect' });
        } catch {
            throw new Error('WebDAV read redirect rejected');
        }

        currentUrl = redirectUrl.toString();
        headers = sanitizedRedirectHeaders(headers);
    }

    throw new Error('WebDAV read redirect rejected');
}

function isRetriableReadResponse(response) {
    return response.status >= 500 && response.status <= 599;
}

async function discardResponseBody(response) {
    try {
        await response.body?.cancel();
    } catch {
        // The retry is still safe when the upstream response cannot be cancelled.
    }
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function normalizeBaseUrl(baseUrl) {
    const normalized = String(baseUrl || '').trim();
    if (!normalized) {
        throw new Error('WebDAV baseUrl is required');
    }

    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('WebDAV baseUrl must use http or https');
    }

    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }

    return url.toString();
}

export function buildWebDAVUrl(baseUrl, path) {
    const cleanPath = String(path || '')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');

    return new URL(cleanPath, normalizeBaseUrl(baseUrl)).toString();
}

export function normalizeWebDAVHeaders(headers) {
    return normalizeHeaders(headers);
}

function getDirectoryParts(path) {
    const parts = String(path || '').replace(/^\/+/, '').split('/').filter(Boolean);
    parts.pop();
    return parts;
}

function normalizeHeaders(headers) {
    if (!headers) return {};

    if (typeof headers === 'string') {
        try {
            const parsed = JSON.parse(headers);
            return normalizeHeaders(parsed);
        } catch {
            return {};
        }
    }

    if (headers instanceof Headers) {
        const result = {};
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    if (typeof headers === 'object' && !Array.isArray(headers)) {
        const result = {};
        for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined && value !== null && value !== '') {
                result[key] = String(value);
            }
        }
        return result;
    }

    return {};
}

function sanitizedRedirectHeaders(headers) {
    const sanitized = new Headers(headers);
    sanitized.delete('Authorization');
    sanitized.delete('Cookie');
    sanitized.delete('Proxy-Authorization');
    sanitized.delete('Host');
    return sanitized;
}

function isSuccessStatus(status) {
    return status >= 200 && status < 300;
}

async function safeReadResponseText(response) {
    try {
        const text = await response.text();
        return text.slice(0, 500);
    } catch {
        return '';
    }
}

function base64EncodeUtf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    if (typeof btoa === 'function') {
        return btoa(binary);
    }

    // Node-based local tests/runtimes.
    return Buffer.from(value, 'utf8').toString('base64');
}
