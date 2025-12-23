(() => {
    const subscribers = {};

    function subscribe(event, handler) {
        if (!subscribers[event]) subscribers[event] = [];
        subscribers[event].push(handler);
        return () => {
            subscribers[event] = (subscribers[event] || []).filter(h => h !== handler);
        };
    }

    function emit(event, payload) {
        (subscribers[event] || []).forEach(fn => {
            try {
                fn(payload);
            } catch (err) {
                console.error(`[store] handler for ${event} failed`, err);
            }
        });
    }

    const EVENTS = {
        DATA_CHANGED: 'DATA_CHANGED'
    };

    window.store = { subscribe, emit, EVENTS };
})();
