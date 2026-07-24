// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugState } from '../debugState';
import { DebuggingExecutor, DebugStopWaitResult, IDebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });
    return { promise, resolve };
}

function runningState(): DebugState {
    const state = new DebugState();
    state.sessionActive = true;
    state.updateConfigurationName('Sample CLI');
    return state;
}

function stoppedState(): DebugState {
    const state = runningState();
    state.updateContext(42, 7);
    state.updateFrameName('processOrder');
    state.updateLocation(
        '/workspace/src/task.ts',
        'task.ts',
        123,
        'job.status === "complete"',
        []
    );
    state.updateBreakpoints(['task.ts:123']);
    return state;
}

const session = {
    id: 'session-123',
    name: 'Sample CLI',
    type: 'node',
    configuration: {
        type: 'node',
        request: 'launch',
        name: 'Sample CLI'
    }
} as vscode.DebugSession;

function makeExecutor(options: {
    waitResult?: Promise<DebugStopWaitResult>;
    state?: DebugState;
} = {}) {
    let waitCalls = 0;
    let continueCalls = 0;
    let stepOverCalls = 0;
    let stepIntoCalls = 0;
    let stepOutCalls = 0;
    let lastWaitTimeoutMs: number | undefined;
    let lastWaitSignal: AbortSignal | undefined;

    const executor: IDebuggingExecutor = {
        startDebugging: async () => ({
            accepted: true,
            session: {
                id: session.id,
                name: session.name,
                type: session.type,
                configuration: session.configuration
            },
            terminated: false
        }),
        debugTestAtCursor: async () => ({
            started: true,
            runComplete: new Promise<void>(() => { /* intentionally running */ })
        }),
        stopDebugging: async () => { /* noop */ },
        stepOver: async () => { stepOverCalls++; },
        stepInto: async () => { stepIntoCalls++; },
        stepOut: async () => { stepOutCalls++; },
        continue: async () => { continueCalls++; },
        restart: async () => { /* noop */ },
        addBreakpoint: async () => { /* noop */ },
        removeBreakpoint: async () => { /* noop */ },
        getCurrentDebugState: async () => options.state ?? runningState(),
        getVariables: async () => ({}),
        evaluateExpression: async () => ({}),
        getBreakpoints: () => [],
        clearAllBreakpoints: () => { /* noop */ },
        hasActiveSession: async () => true,
        getActiveSession: () => session,
        waitForDebugStop: async (timeoutMs, signal) => {
            waitCalls++;
            lastWaitTimeoutMs = timeoutMs;
            lastWaitSignal = signal;
            return await (options.waitResult ?? Promise.resolve({ outcome: 'timeout' as const }));
        },
        executeControlAndWait: async (control, timeoutMs, signal) => {
            waitCalls++;
            lastWaitTimeoutMs = timeoutMs;
            lastWaitSignal = signal;
            await control();
            return await (options.waitResult ?? Promise.resolve({ outcome: 'timeout' as const }));
        }
    };

    return {
        executor,
        calls: {
            get wait() { return waitCalls; },
            get continue() { return continueCalls; },
            get stepOver() { return stepOverCalls; },
            get stepInto() { return stepIntoCalls; },
            get stepOut() { return stepOutCalls; },
            get lastWaitTimeoutMs() { return lastWaitTimeoutMs; },
            get lastWaitSignal() { return lastWaitSignal; }
        }
    };
}

suite('DebuggingHandler non-blocking command semantics', () => {
    test('continue returns without waiting for another breakpoint', async () => {
        const neverStops = new Promise<DebugStopWaitResult>(() => { /* intentionally pending */ });
        const fake = makeExecutor({ waitResult: neverStops });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);

        const output = JSON.parse(await handler.handleContinue());
        assert.strictEqual(output.accepted, true);
        assert.strictEqual(output.command, 'continue');
        assert.strictEqual(output.state, 'running');
        assert.strictEqual(fake.calls.continue, 1);
        assert.strictEqual(fake.calls.wait, 0);
    });

    test('step operations return after command acceptance', async () => {
        const neverStops = new Promise<DebugStopWaitResult>(() => { /* intentionally pending */ });
        const fake = makeExecutor({ waitResult: neverStops });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);

        assert.strictEqual(JSON.parse(await handler.handleStepOver()).accepted, true);
        assert.strictEqual(JSON.parse(await handler.handleStepInto()).accepted, true);
        assert.strictEqual(JSON.parse(await handler.handleStepOut()).accepted, true);
        assert.deepStrictEqual(
            [fake.calls.stepOver, fake.calls.stepInto, fake.calls.stepOut, fake.calls.wait],
            [1, 1, 1, 0]
        );
    });

    test('continue can wait for the next stop with a bounded timeout', async () => {
        const stop = deferred<DebugStopWaitResult>();
        const fake = makeExecutor({ waitResult: stop.promise, state: stoppedState() });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);

        const pending = handler.handleContinue({ timeoutMs: 5_000 });
        stop.resolve({ outcome: 'stopped' });
        const output = JSON.parse(await pending);

        assert.strictEqual(fake.calls.continue, 1);
        assert.strictEqual(fake.calls.wait, 1);
        assert.strictEqual(output.accepted, true);
        assert.strictEqual(output.command, 'continue');
        assert.strictEqual(output.timeoutMs, 5_000);
        assert.strictEqual(output.outcome, 'stopped');
        assert.strictEqual(output.reason, 'breakpoint');
        assert.strictEqual(output.state.currentLine, 123);
    });

    test('step wait forwards the MCP cancellation signal', async () => {
        const fake = makeExecutor({
            waitResult: Promise.resolve({ outcome: 'timeout' }),
            state: runningState()
        });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);
        const controller = new AbortController();

        await handler.handleStepOver({ timeoutMs: 60_000 }, controller.signal);

        assert.strictEqual(fake.calls.stepOver, 1);
        assert.strictEqual(fake.calls.lastWaitTimeoutMs, 60_000);
        assert.strictEqual(fake.calls.lastWaitSignal, controller.signal);
    });

    test('explicit wait resolves when a stop event arrives', async () => {
        const stop = deferred<DebugStopWaitResult>();
        const fake = makeExecutor({ waitResult: stop.promise, state: stoppedState() });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);
        const controller = new AbortController();

        const pending = handler.handleWaitForDebugStop({ timeoutMs: 5_000 }, controller.signal);
        stop.resolve({ outcome: 'stopped' });
        const output = JSON.parse(await pending);

        assert.strictEqual(output.outcome, 'stopped');
        assert.strictEqual(output.timeoutMs, 5_000);
        assert.strictEqual(output.reason, 'breakpoint');
        assert.strictEqual(output.state.fileFullPath, '/workspace/src/task.ts');
        assert.strictEqual(output.state.currentLine, 123);
        assert.strictEqual(fake.calls.wait, 1);
        assert.strictEqual(fake.calls.lastWaitSignal, controller.signal);
    });

    test('explicit wait reports a clear timeout', async () => {
        const fake = makeExecutor({
            waitResult: Promise.resolve({ outcome: 'timeout' }),
            state: runningState()
        });
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);

        const output = JSON.parse(await handler.handleWaitForDebugStop({ timeoutMs: 10 }));
        assert.strictEqual(output.outcome, 'timeout');
        assert.match(output.message, /did not stop or terminate within 10 ms/);
    });

    test('wait timeout must be a positive integer number of milliseconds', async () => {
        const fake = makeExecutor();
        const handler = new DebuggingHandler(fake.executor, {} as never, 300);

        await assert.rejects(
            handler.handleContinue({ timeoutMs: 1.5 }),
            /timeoutMs must be a positive integer/
        );
        assert.strictEqual(fake.calls.continue, 0);
        assert.strictEqual(fake.calls.wait, 0);
    });
});

suite('DebuggingExecutor cancellation semantics', () => {
    test('an already-cancelled combined wait does not dispatch its control command', async () => {
        const executor = new DebuggingExecutor();
        const controller = new AbortController();
        let dispatched = false;
        controller.abort();

        await assert.rejects(
            executor.executeControlAndWait(async () => {
                dispatched = true;
            }, 60_000, controller.signal),
            (error: unknown) => error instanceof Error && error.name === 'AbortError'
        );
        assert.strictEqual(dispatched, false);
    });

    test('an already-cancelled explicit wait rejects as AbortError', async () => {
        const executor = new DebuggingExecutor();
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(
            executor.waitForDebugStop(60_000, controller.signal),
            (error: unknown) => error instanceof Error && error.name === 'AbortError'
        );
    });
});
