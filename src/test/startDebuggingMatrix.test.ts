// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugState } from '../debugState';
import {
    DebugLaunchResult,
    IDebuggingExecutor,
    TestDebugDispatch
} from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

interface MockOptions {
    startResult?: DebugLaunchResult | Error;
    testDispatch?: TestDebugDispatch | Error;
    debugConfig?: string | vscode.DebugConfiguration | Error;
    language?: string;
    state?: DebugState;
    activeSession?: vscode.DebugSession;
}

function sessionDetails(language: string, name: string) {
    return {
        id: `session-${language}`,
        name,
        type: language,
        configuration: {
            type: language,
            request: 'launch',
            name
        } as vscode.DebugConfiguration
    };
}

function makeMocks(options: MockOptions) {
    let waitCalls = 0;
    let capturedConfig: string | vscode.DebugConfiguration | undefined;
    let capturedCwd: string | undefined;
    const state = options.state ?? new DebugState();

    const executor: IDebuggingExecutor = {
        startDebugging: async (cwd, config) => {
            capturedCwd = cwd;
            capturedConfig = config;
            if (options.startResult instanceof Error) {
                throw options.startResult;
            }
            return options.startResult ?? {
                accepted: true,
                session: sessionDetails(options.language ?? 'node', 'DebugMCP Launch'),
                terminated: false
            };
        },
        debugTestAtCursor: async () => {
            if (options.testDispatch instanceof Error) {
                throw options.testDispatch;
            }
            return options.testDispatch ?? {
                started: true,
                runComplete: new Promise<void>(() => { /* intentionally running */ })
            };
        },
        stopDebugging: async () => { /* noop */ },
        stepOver: async () => { /* noop */ },
        stepInto: async () => { /* noop */ },
        stepOut: async () => { /* noop */ },
        continue: async () => { /* noop */ },
        restart: async () => { /* noop */ },
        addBreakpoint: async () => { /* noop */ },
        removeBreakpoint: async () => { /* noop */ },
        getCurrentDebugState: async () => state,
        getVariables: async () => ({}),
        evaluateExpression: async () => ({}),
        getBreakpoints: () => [],
        clearAllBreakpoints: () => { /* noop */ },
        hasActiveSession: async () => options.activeSession !== undefined,
        getActiveSession: () => options.activeSession,
        waitForDebugStop: async () => {
            waitCalls++;
            return { outcome: 'timeout' };
        },
        executeControlAndWait: async (control) => {
            await control();
            waitCalls++;
            return { outcome: 'timeout' };
        }
    };

    const configManager: IDebugConfigurationManager = {
        getDebugConfig: async () => {
            if (options.debugConfig instanceof Error) {
                throw options.debugConfig;
            }
            return options.debugConfig ?? {
                type: options.language ?? 'node',
                request: 'launch',
                name: 'DebugMCP Launch',
                program: 'unused'
            };
        },
        detectLanguageFromFilePath: () => options.language ?? 'node'
    };

    return {
        executor,
        configManager,
        getCapturedConfig: () => capturedConfig,
        getCapturedCwd: () => capturedCwd,
        getWaitCalls: () => waitCalls
    };
}

interface LanguageCase {
    label: string;
    file: string;
    debuggerType: string;
}

const LANGUAGES: LanguageCase[] = [
    { label: 'Python',     file: '/repo/src/app.py',      debuggerType: 'python' },
    { label: 'JavaScript', file: '/repo/src/app.js',      debuggerType: 'pwa-node' },
    { label: 'TypeScript', file: '/repo/src/app.ts',      debuggerType: 'pwa-node' },
    { label: 'Java',       file: '/repo/src/App.java',    debuggerType: 'java' },
    { label: 'C#',         file: '/repo/src/AppTests.cs', debuggerType: 'coreclr' },
    { label: 'C++',        file: '/repo/src/app.cpp',     debuggerType: 'cppdbg' },
    { label: 'Go',         file: '/repo/src/main.go',     debuggerType: 'go' }
];

suite('handleStartDebugging language/configuration matrix', () => {
    for (const language of LANGUAGES) {
        test(`[${language.label}] launch returns promptly after acceptance`, async () => {
            const requestedName = `${language.label} Launch`;
            const mocks = makeMocks({
                language: language.debuggerType,
                debugConfig: requestedName,
                startResult: {
                    accepted: true,
                    session: sessionDetails(language.debuggerType, requestedName),
                    terminated: false
                }
            });
            const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

            const output = JSON.parse(await handler.handleStartDebugging({
                fileFullPath: language.file,
                workingDirectory: '/repo',
                configurationName: requestedName
            }));

            assert.strictEqual(output.accepted, true);
            assert.strictEqual(output.requestedConfigurationName, requestedName);
            assert.strictEqual(output.session.type, language.debuggerType);
            assert.strictEqual(output.state, 'running');
            assert.strictEqual(mocks.getWaitCalls(), 0);
        });

        test(`[${language.label}] test launch dispatch returns without waiting`, async () => {
            const mocks = makeMocks({
                language: language.debuggerType,
                testDispatch: {
                    started: true,
                    runComplete: new Promise<void>(() => { /* intentionally running */ })
                }
            });
            const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

            const output = JSON.parse(await handler.handleStartDebugging({
                fileFullPath: language.file,
                workingDirectory: '/repo',
                testName: 'My_Test'
            }));

            assert.strictEqual(output.accepted, true);
            assert.match(output.requestedConfigurationName, /testing\.debugAtCursor/);
            assert.strictEqual(output.state, 'starting');
            assert.strictEqual(mocks.getWaitCalls(), 0);
        });

        test(`[${language.label}] failed launch is clear`, async () => {
            const mocks = makeMocks({
                language: language.debuggerType,
                startResult: { accepted: false, terminated: false }
            });
            const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

            await assert.rejects(
                handler.handleStartDebugging({
                    fileFullPath: language.file,
                    workingDirectory: '/repo'
                }),
                /Failed to start debug session/
            );
        });
    }

    test('[C#] configuration-resolution error remains clear', async () => {
        const mocks = makeMocks({
            language: 'coreclr',
            debugConfig: new Error('No built DLL found. Run dotnet build first.')
        });
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

        await assert.rejects(
            handler.handleStartDebugging({
                fileFullPath: '/repo/src/AppTests.cs',
                workingDirectory: '/repo'
            }),
            /No built DLL found/
        );
    });

    test('test-dispatch failure remains clear', async () => {
        const mocks = makeMocks({
            testDispatch: new Error('Could not locate test')
        });
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

        await assert.rejects(
            handler.handleStartDebugging({
                fileFullPath: '/repo/src/app.test.ts',
                workingDirectory: '/repo',
                testName: 'missing test'
            }),
            /Could not locate test/
        );
    });
});

suite('handleStartDebuggingWithConfig', () => {
    test('forwards inline configuration and reports resolved session details', async () => {
        const resolved = sessionDetails('node', 'Resolved Launch');
        resolved.configuration.program = '/repo/scripts/foo.ts';
        resolved.configuration.runtimeExecutable = 'tsx';
        resolved.configuration.env = { API_TOKEN: 'secret-value' };
        const mocks = makeMocks({
            startResult: {
                accepted: true,
                session: resolved,
                terminated: false
            }
        });
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);
        const requested = {
            type: 'node',
            request: 'launch' as const,
            name: 'Requested Launch',
            program: '/repo/scripts/foo.ts',
            runtimeExecutable: 'tsx',
            args: ['--flag', 'value']
        };

        const output = JSON.parse(await handler.handleStartDebuggingWithConfig({
            configuration: requested,
            workingDirectory: '/repo'
        }));

        assert.deepStrictEqual(mocks.getCapturedConfig(), requested);
        assert.strictEqual(mocks.getCapturedCwd(), '/repo');
        assert.strictEqual(output.requestedConfigurationName, 'Requested Launch');
        assert.strictEqual(output.actualConfiguration.name, 'Resolved Launch');
        assert.strictEqual(output.actualConfiguration.env.API_TOKEN, '[redacted]');
        assert.strictEqual(output.session.id, 'session-node');
        assert.strictEqual(output.state, 'running');
    });

    test('reports termination that occurs during launch', async () => {
        const mocks = makeMocks({
            startResult: {
                accepted: true,
                session: sessionDetails('python', 'Short Python'),
                terminated: true
            }
        });
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);

        const output = JSON.parse(await handler.handleStartDebuggingWithConfig({
            configuration: {
                type: 'python',
                request: 'launch',
                name: 'Short Python',
                program: '/repo/app.py'
            },
            workingDirectory: '/repo'
        }));

        assert.strictEqual(output.accepted, true);
        assert.strictEqual(output.state, 'terminated');
    });

    test('defaults a missing name', async () => {
        const mocks = makeMocks({});
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);
        const configuration = {
            type: 'node',
            request: 'attach',
            port: 9229
        } as unknown as vscode.DebugConfiguration;

        await handler.handleStartDebuggingWithConfig({
            configuration,
            workingDirectory: '/repo'
        });

        assert.strictEqual(configuration.name, 'DebugMCP Inline');
    });

    test('rejects a missing type', async () => {
        const mocks = makeMocks({});
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);
        await assert.rejects(
            handler.handleStartDebuggingWithConfig({
                configuration: {
                    request: 'launch',
                    program: '/x'
                } as unknown as vscode.DebugConfiguration,
                workingDirectory: '/repo'
            }),
            /configuration\.type is required/
        );
    });

    test('rejects an invalid request', async () => {
        const mocks = makeMocks({});
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);
        await assert.rejects(
            handler.handleStartDebuggingWithConfig({
                configuration: {
                    type: 'node',
                    request: 'connect',
                    program: '/x'
                } as unknown as vscode.DebugConfiguration,
                workingDirectory: '/repo'
            }),
            /request must be 'launch' or 'attach'/
        );
    });

    test('surfaces a failed inline launch', async () => {
        const mocks = makeMocks({
            startResult: { accepted: false, terminated: false }
        });
        const handler = new DebuggingHandler(mocks.executor, mocks.configManager, 300);
        await assert.rejects(
            handler.handleStartDebuggingWithConfig({
                configuration: {
                    type: 'node',
                    request: 'launch',
                    name: 'broken',
                    program: '/x'
                },
                workingDirectory: '/repo'
            }),
            /Failed to start debug session/
        );
    });
});
