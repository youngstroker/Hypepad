export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export async function api(path, { method = 'GET', body, raw } = {}) {
    const init = { method, headers: {} };
    if (raw) {
        init.body = raw;
        init.headers['content-type'] = raw.type || 'application/octet-stream';
    } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
    }
    let res;
    try {
        res = await fetch(`/api${path}`, init);
    } catch {
        throw new ApiError('Network error. Check your connection and try again.', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    return data;
}
