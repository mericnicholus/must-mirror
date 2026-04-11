(function attachMustMirrorSecurity(globalScope) {
    function blockEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }
        return false;
    }

    function protectPage() {
        if (document.documentElement.dataset.mustMirrorProtected === 'true') {
            return;
        }

        document.documentElement.dataset.mustMirrorProtected = 'true';

        const blockedShortcutKeys = new Set(['a', 'c', 'p', 's', 'u', 'v', 'x']);
        const blockedInspectorKeys = new Set(['c', 'i', 'j', 'k']);

        [
            'contextmenu',
            'copy',
            'cut',
            'paste',
            'beforecopy',
            'beforecut',
            'beforepaste',
            'selectstart',
            'dragstart'
        ].forEach((eventName) => {
            document.addEventListener(eventName, blockEvent, true);
        });

        document.addEventListener('keydown', (event) => {
            const key = String(event.key || '').toLowerCase();
            const hasCtrlOrMeta = event.ctrlKey || event.metaKey;

            if (key === 'f12' || key === 'printscreen') {
                blockEvent(event);
                return;
            }

            if (hasCtrlOrMeta && blockedShortcutKeys.has(key)) {
                blockEvent(event);
                return;
            }

            if (hasCtrlOrMeta && event.shiftKey && blockedInspectorKeys.has(key)) {
                blockEvent(event);
                return;
            }

            if ((event.metaKey || event.ctrlKey) && event.altKey && (key === 'i' || key === 'u')) {
                blockEvent(event);
            }
        }, true);
    }

    globalScope.MustMirrorSecurity = {
        protectPage
    };
})(window);
