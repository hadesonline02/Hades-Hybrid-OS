(function initHadesScheduler(globalScope, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    globalScope.HADESScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSchedulerModule() {
    'use strict';

    class SchedulerEngine {
        constructor(config = {}) {
            this.tickMs = Math.max(200, parseInt(config.tickMs, 10) || 1000);
            this.onFire = typeof config.onFire === 'function' ? config.onFire : () => {};
            this.nowFn = typeof config.nowFn === 'function' ? config.nowFn : () => Date.now();
            this.timer = null;
            this.tasks = [];
        }

        addTask(task = {}) {
            const id = task.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const normalizedTask = {
                id,
                type: task.type || 'deferred_action',
                datetimeISO: task.datetimeISO,
                repeat: task.repeat || 'none',
                payload: task.payload || {},
                status: task.status || 'scheduled',
                createdAtISO: task.createdAtISO || new Date().toISOString(),
                lastFiredAtISO: task.lastFiredAtISO || null
            };
            this.tasks.push(normalizedTask);
            return normalizedTask;
        }

        listTasks() {
            return [...this.tasks];
        }

        cancelTask(taskId) {
            const target = this.tasks.find((task) => task.id === taskId);
            if (!target) return false;
            target.status = 'cancelled';
            return true;
        }

        tick(nowInput = null) {
            const nowMs = nowInput instanceof Date
                ? nowInput.getTime()
                : (typeof nowInput === 'number' ? nowInput : this.nowFn());

            const firedTasks = [];
            for (const task of this.tasks) {
                if (task.status !== 'scheduled') continue;
                const taskMs = Date.parse(task.datetimeISO);
                if (Number.isNaN(taskMs)) continue;
                if (taskMs > nowMs) continue;

                task.status = 'fired';
                task.lastFiredAtISO = new Date(nowMs).toISOString();
                firedTasks.push(task);
                this.onFire(task);
            }

            return firedTasks;
        }

        start() {
            if (this.timer) return;
            this.timer = setInterval(() => {
                this.tick();
            }, this.tickMs);
        }

        stop() {
            if (!this.timer) return;
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    return Object.freeze({
        SchedulerEngine
    });
});
