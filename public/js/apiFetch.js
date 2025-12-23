(() => {
    async function apiFetch(url, options = {}) {
        const resp = await fetch(url, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            ...options
        });

        if (resp.status === 401) {
            window.location.href = '/login.html';
            return Promise.reject(new Error('Unauthorized'));
        }

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(text || `Request failed with ${resp.status}`);
        }
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return resp.json();
        }
        return resp.text();
    }

    window.apiFetch = apiFetch;
})();
