(function attachHadesCoreLogger(globalScope) {
    'use strict';

    const DEFAULT_SCOPE = 'HADES';

    const toIsoTimestamp = () => new Date().toISOString();

    const formatStateTransition = (fromState, toState, eventName, detail = '') => {
        const safeDetail = detail ? `, ${detail}` : '';
        return `STATE::${fromState} -> STATE::${toState} (event=${eventName}${safeDetail})`;
    };

    const formatOpsLog = (payload = {}) => JSON.stringify({
        ts: payload.ts || toIsoTimestamp(),
        ...payload
    });

    const formatToolCall = (toolName, payload = {}, status = 'start', extra = {}) => JSON.stringify({
        ts: toIsoTimestamp(),
        type: 'tool_call',
        tool: toolName,
        status,
        payload,
        ...extra
    });

    const createLogger = (options = {}) => {
        const scope = options.scope || DEFAULT_SCOPE;
        const sink = typeof options.sink === 'function' ? options.sink : null;

        const write = (message, isError = false, meta = {}) => {
            const line = `[${new Date().toLocaleTimeString()}] ${message}`;
            if (sink) {
                sink({ line, message, isError, scope, meta });
                return line;
            }

            if (isError) {
                console.error(line);
            } else {
                console.log(line);
            }

            return line;
        };

        return {
            log: (message, options = {}) => write(message, Boolean(options.isError), options),
            error: (message, options = {}) => write(message, true, options),
            stateTransition: (fromState, toState, eventName, detail = '') => write(
                formatStateTransition(fromState, toState, eventName, detail),
                false,
                { kind: 'state_transition' }
            ),
            toolCall: (toolName, payload = {}, status = 'start', extra = {}) => write(
                formatToolCall(toolName, payload, status, extra),
                false,
                { kind: 'tool_call' }
            ),
            ops: (payload = {}) => write(
                formatOpsLog(payload),
                false,
                { kind: 'ops' }
            )
        };
    };

    globalScope.HADESCoreLogger = Object.freeze({
        createLogger,
        formatStateTransition,
        formatOpsLog,
        formatToolCall
    });
})(window);
