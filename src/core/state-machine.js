(function attachHadesStateMachine(globalScope) {
    'use strict';

    const createStateMachine = (config = {}) => {
        const transitions = config.transitions || {};
        const fatalErrorState = config.fatalErrorState || null;
        let currentState = config.initialState || 'IDLE';

        const resolveNextState = (eventName) => {
            if (eventName === 'FATAL_ERROR' && fatalErrorState) {
                return fatalErrorState;
            }

            const stateTransitions = transitions[currentState] || {};
            return stateTransitions[eventName] || currentState;
        };

        return {
            getState: () => currentState,
            transition: (eventName, detail = '') => {
                const fromState = currentState;
                const toState = resolveNextState(eventName);
                currentState = toState;

                return {
                    from: fromState,
                    to: toState,
                    event: eventName,
                    detail,
                    changed: fromState !== toState
                };
            },
            reset: (nextState) => {
                currentState = nextState;
                return currentState;
            }
        };
    };

    globalScope.HADESStateMachine = Object.freeze({
        createStateMachine
    });
})(window);
