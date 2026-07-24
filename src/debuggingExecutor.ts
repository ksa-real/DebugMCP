// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugState, StackFrame } from './debugState';
import { logger } from './utils/logger';

/**
 * Outcome of dispatching `testing.debugAtCursor`.
 *
 * `started` indicates the command was dispatched successfully.
 * `runComplete` resolves when the underlying test run *finishes* (pass, fail,
 * or aborted). The start handler deliberately does not await it; it is retained
 * so asynchronous command failures are observed instead of becoming unhandled.
 */
export interface TestDebugDispatch {
    started: boolean;
    runComplete: Promise<void>;
}

export interface DebugSessionDetails {
    id: string;
    name: string;
    type: string;
    configuration: vscode.DebugConfiguration;
}

export interface DebugLaunchResult {
    accepted: boolean;
    session?: DebugSessionDetails;
    terminated: boolean;
}

export type DebugStopWaitResult =
    | { outcome: 'stopped' }
    | { outcome: 'terminated' }
    | { outcome: 'timeout' };

/**
 * Interface for debugging execution operations
 */
export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: string | vscode.DebugConfiguration): Promise<DebugLaunchResult>;
    debugTestAtCursor(fileFullPath: string, testName: string): Promise<TestDebugDispatch>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(): Promise<void>;
    stepInto(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number, condition?: string): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any>;
    evaluateExpression(expression: string, frameId: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    waitForDebugStop(timeoutMs: number, signal?: AbortSignal): Promise<DebugStopWaitResult>;
    executeControlAndWait(
        control: () => Promise<void>,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<DebugStopWaitResult>;
}

interface DebugStopWaitHandle {
    promise: Promise<DebugStopWaitResult>;
    cancel: () => void;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workingDirectory: string, 
        config: string | vscode.DebugConfiguration
    ): Promise<DebugLaunchResult> {
        let startedSession: vscode.DebugSession | undefined;
        let terminated = false;
        const subscriptions = [
            vscode.debug.onDidStartDebugSession(session => {
                startedSession = session;
            }),
            vscode.debug.onDidTerminateDebugSession(session => {
                if (startedSession?.id === session.id) {
                    terminated = true;
                }
            })
        ];

        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
            const accepted = await vscode.debug.startDebugging(workspaceFolder, config);
            const session = startedSession ?? vscode.debug.activeDebugSession;
            return {
                accepted,
                session: session ? this.describeSession(session) : undefined,
                terminated
            };
        } catch (error) {
            throw new Error(`Failed to start debugging: ${error}`);
        } finally {
            subscriptions.forEach(subscription => subscription.dispose());
        }
    }

    private describeSession(session: vscode.DebugSession): DebugSessionDetails {
        return {
            id: session.id,
            name: session.name,
            type: session.type,
            configuration: session.configuration
        };
    }

    /**
     * Debug a single test by routing through VS Code's Testing API.
     *
     * Works for any language whose extension registers a TestController
     * (Python, Jest/Mocha, JUnit, C# Dev Kit, Go, Rust, ...). This is the
     * only correct way to debug `dotnet test` and similar runners where
     * the actual test code runs in a child process — the language's test
     * integration handles the parent/child debugger attach.
     *
     * Implementation strategy:
     *  1. Open the file in an editor.
     *  2. Place the cursor on the test method's definition line.
     *  3. Execute the built-in `testing.debugAtCursor` command.
     *
     * The handler's existing readiness wait picks up the resulting session.
     */
    public async debugTestAtCursor(fileFullPath: string, testName: string): Promise<TestDebugDispatch> {
        const positioned = await this.positionCursorAtTest(fileFullPath, testName);
        if (!positioned) {
            throw new Error(
                `Could not locate test '${testName}' in ${fileFullPath}. ` +
                `Check the test name, or pass a launch.json configurationName instead.`
            );
        }

        // Trigger test discovery before dispatching. Some controllers (notably
        // Python's) lazily discover tests on first Test Explorer open; without
        // this, testing.debugAtCursor silently no-ops because no TestItem exists
        // at the cursor yet. refreshTests typically resolves once discovery is
        // complete, but we add a small grace period for controllers that report
        // completion before all TestItems are registered.
        try {
            await vscode.commands.executeCommand('testing.refreshTests');
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch {
            // Not fatal — debugAtCursor may still work if tests were already discovered.
        }

        // `testing.debugAtCursor` resolves only when the entire test run
        // completes, not when the debug session starts. Dispatch it without
        // awaiting so start_debugging returns promptly; retain the completion
        // promise only to observe asynchronous command failures.
        const runComplete = Promise.resolve(vscode.commands.executeCommand('testing.debugAtCursor'))
            .then(() => undefined)
            .catch(err => {
                logger.error(`testing.debugAtCursor failed: ${err}`);
            });
        return { started: true, runComplete };
    }

    /**
     * Open the file and move the active editor's cursor to the line that
     * defines `testName`. Tries language-aware patterns first, then falls
     * back to a literal substring search (covers JS/TS `it('name')` style
     * where the test name is a string literal, not an identifier).
     *
     * The cursor is placed on the test name itself (not on the preceding
     * `void`/`def`/etc. keyword) because some TestController implementations
     * — notably C# Dev Kit — register tight TestItem ranges around the
     * method name. A cursor outside that range causes testing.debugAtCursor
     * to fall back to the first test in the file.
     *
     * The cursor position is passed via the `selection` option to
     * showTextDocument so it's applied atomically with the open — separate
     * `editor.selection = ...` writes race testing.debugAtCursor.
     */
    private async positionCursorAtTest(fileFullPath: string, testName: string): Promise<boolean> {
        const uri = vscode.Uri.file(fileFullPath);
        const doc = await vscode.workspace.openTextDocument(uri);

        const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
            // identifier-style definitions: def/void/func/fn/fun/etc NAME(
            new RegExp(`\\b(?:def|void|func|fn|fun|sub|Task|async|public|private|protected|internal|static)\\b[^\\n]*?\\b(${escaped})\\s*\\(`),
            // bare identifier followed by (
            new RegExp(`\\b(${escaped})\\s*\\(`),
            // last resort: any substring match (covers it('add two numbers', ...))
            new RegExp(`(${escaped})`)
        ];

        let target: vscode.Position | undefined;
        for (const pattern of patterns) {
            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text;
                const match = pattern.exec(line);
                if (match) {
                    // Place cursor one line below the method signature, inside
                    // the body. The method-name line itself can be outside the
                    // TestItem range used by some test controllers (notably
                    // C# Dev Kit), causing testing.debugAtCursor to fall back
                    // to the first test in the file. Landing inside the body
                    // is reliably within the TestItem range across languages.
                    const bodyLine = Math.min(i + 1, doc.lineCount - 1);
                    const bodyText = doc.lineAt(bodyLine).text;
                    const indent = bodyText.match(/^\s*/)?.[0].length ?? 0;
                    target = new vscode.Position(bodyLine, indent);
                    break;
                }
            }
            if (target) {
                break;
            }
        }

        if (!target) {
            return false;
        }

        const selection = new vscode.Range(target, target);
        const editor = await vscode.window.showTextDocument(doc, {
            selection,
            preserveFocus: false,
            preview: false
        });

        // Belt-and-suspenders: showTextDocument's `selection` option sets the
        // selection but doesn't always scroll the viewport, especially when the
        // editor was already open. Explicitly reveal to guarantee the cursor
        // line is visible (and, more importantly, is the active line).
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);

        // Wait until VS Code considers this editor active. testing.debugAtCursor
        // reads the active editor synchronously, so without this small wait the
        // command can race and pick whichever editor was previously focused.
        await this.waitForActiveEditor(uri);
        return true;
    }

    private async waitForActiveEditor(uri: vscode.Uri, timeoutMs = 1500): Promise<void> {
        const matches = (editor: vscode.TextEditor | undefined) =>
            editor?.document.uri.toString() === uri.toString();

        if (matches(vscode.window.activeTextEditor)) {
            return;
        }

        await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve();
            }, timeoutMs);
            const disposable = vscode.window.onDidChangeActiveTextEditor(editor => {
                if (matches(editor)) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve();
                }
            });
        });
    }

    /**
     * Stop the debugging session
     */
    public async stopDebugging(session?: vscode.DebugSession): Promise<void> {
        try {
            const activeSession = session || vscode.debug.activeDebugSession;
            if (activeSession) {
                await vscode.debug.stopDebugging(activeSession);
            }
        } catch (error) {
            throw new Error(`Failed to stop debugging: ${error}`);
        }
    }

    /**
     * Execute step over command
     */
    public async stepOver(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        } catch (error) {
            throw new Error(`Failed to step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async stepInto(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepInto');
        } catch (error) {
            throw new Error(`Failed to step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async stepOut(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepOut');
        } catch (error) {
            throw new Error(`Failed to step out: ${error}`);
        }
    }

    /**
     * Execute continue command
     */
    public async continue(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.continue');
        } catch (error) {
            throw new Error(`Failed to continue: ${error}`);
        }
    }

    /**
     * Execute restart command
     */
    public async restart(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.restart');
        } catch (error) {
            throw new Error(`Failed to restart: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location. An optional condition makes it a
     * conditional breakpoint that only pauses execution when the expression
     * evaluates to true.
     */
    public async addBreakpoint(uri: vscode.Uri, line: number, condition?: string): Promise<void> {
        try {
            const breakpoint = new vscode.SourceBreakpoint(
                new vscode.Location(uri, new vscode.Position(line - 1, 0)),
                true,
                condition
            );
            vscode.debug.addBreakpoints([breakpoint]);
        } catch (error) {
            throw new Error(`Failed to add breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async removeBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoints = vscode.debug.breakpoints.filter(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (breakpoints.length > 0) {
                vscode.debug.removeBreakpoints(breakpoints);
            }
        } catch (error) {
            throw new Error(`Failed to remove breakpoint: ${error}`);
        }
    }

    /**
     * Get current debugging state
     */
    public async getCurrentDebugState(numNextLines: number = 3): Promise<DebugState> {
        const state = new DebugState();
        
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (activeSession) {
                state.sessionActive = true;
                state.updateConfigurationName(activeSession.configuration.name ?? null);
                
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem && 'frameId' in activeStackItem) {
                    state.updateContext(activeStackItem.frameId, activeStackItem.threadId);

                    // Pull the current location from the debug adapter's top stack
                    // frame (via stackTrace) instead of scraping the active text
                    // editor. VS Code updates the editor cursor/selection
                    // asynchronously after a stop and only for the focused editor,
                    // so reading it here was both racy (it lagged the actual stop)
                    // and wrong when focus was elsewhere — the source of stale
                    // "current line" reports. The DAP frame is ground truth.
                    const topFrame = await this.extractFrameName(activeSession, activeStackItem.frameId, state);

                    if (topFrame?.path && typeof topFrame.line === 'number') {
                        await this.populateLocationFromFrame(state, topFrame.path, topFrame.line, numNextLines);
                    }
                }
            }
        } catch (error) {
            console.log('Unable to get debug state:', error);
        }
        
        // Populate breakpoints as compact "fileName:line" strings
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints
            .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
            .map(bp => {
                const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop() || 'unknown';
                const line = bp.location.range.start.line + 1;
                const base = `${fileName}:${line}`;
                return bp.condition ? `${base} [when: ${bp.condition}]` : base;
            });
        state.updateBreakpoints(formattedBreakpoints);

        return state;
    }

    /**
     * Extract frame name and stack trace from the current debug session.
     *
     * Returns the top frame's source location ({ path, line, column }) so the
     * caller can report the authoritative current position without scraping the
     * editor. Returns undefined if no stack frame is available.
     */
    private async extractFrameName(
        session: vscode.DebugSession,
        frameId: number,
        state: DebugState
    ): Promise<{ path?: string; line?: number; column?: number } | undefined> {
        try {
            const stackTraceResponse = await session.customRequest('stackTrace', {
                threadId: state.threadId,
                startFrame: 0,
                levels: 50
            });

            if (stackTraceResponse?.stackFrames && stackTraceResponse.stackFrames.length > 0) {
                // Extract frame name from current frame
                const currentFrame = stackTraceResponse.stackFrames[0];
                state.updateFrameName(currentFrame.name || null);

                // Build stack trace array
                const stackTrace: StackFrame[] = stackTraceResponse.stackFrames.map((frame: any) => ({
                    name: frame.name || 'unknown',
                    source: frame.source?.path || frame.source?.name || undefined,
                    line: frame.line || undefined,
                    column: frame.column || undefined,
                }));

                state.updateStackTrace(stackTrace);

                // DAP line/column are 1-based (VS Code's default). Hand the raw
                // top-frame location back to the caller for location reporting.
                return {
                    path: currentFrame.source?.path,
                    line: currentFrame.line,
                    column: currentFrame.column,
                };
            }
        } catch (error) {
            console.log('Unable to extract stack info:', error);
            // Set empty values on error
            state.updateFrameName(null);
            state.updateStackTrace([]);
        }
        return undefined;
    }

    /**
     * Populate the DebugState location (file, current line + content, and the
     * next few non-empty lines) by reading the source document at the debugger's
     * current frame line. Uses the DAP-reported path/line rather than the active
     * editor, so it's accurate regardless of which editor (if any) has focus.
     */
    private async populateLocationFromFrame(
        state: DebugState,
        filePath: string,
        line: number,
        numNextLines: number
    ): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const zeroBasedLine = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
            const fileName = filePath.split(/[/\\]/).pop() || '';
            const currentLineContent = doc.lineAt(zeroBasedLine).text.trim();

            // Collect the next non-empty lines for lookahead context.
            const nextLines: string[] = [];
            let lineOffset = 1;
            while (nextLines.length < numNextLines && zeroBasedLine + lineOffset < doc.lineCount) {
                const lineText = doc.lineAt(zeroBasedLine + lineOffset).text.trim();
                if (lineText.length > 0) {
                    nextLines.push(lineText);
                }
                lineOffset++;
            }

            state.updateLocation(filePath, fileName, line, currentLineContent, nextLines);
        } catch (error) {
            // Native/library frames or paths VS Code can't open won't resolve to
            // a document; degrade gracefully and leave location unset.
            console.log('Unable to read frame source document:', error);
        }
    }

    /**
     * Get variables from the current debug context
     */
    public async getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('scopes', { frameId });
            
            if (!response || !response.scopes || response.scopes.length === 0) {
                return { scopes: [] };
            }

            const filteredScopes = response.scopes.filter((scopeItem: any) => {
                if (scope === 'all') {return true;}
                const scopeName = scopeItem.name.toLowerCase();
                if (scope === 'local') {return scopeName.includes('local');}
                if (scope === 'global') {return scopeName.includes('global');}
                return true;
            });

            // Get variables for each scope
            for (const scopeItem of filteredScopes) {
                try {
                    const variablesResponse = await activeSession.customRequest('variables', {
                        variablesReference: scopeItem.variablesReference
                    });
                    scopeItem.variables = variablesResponse.variables || [];
                } catch (scopeError) {
                    scopeItem.variables = [];
                    scopeItem.error = scopeError;
                }
            }

            return { scopes: filteredScopes };
        } catch (error) {
            throw new Error(`Failed to get variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in the current debug context
     */
    public async evaluateExpression(expression: string, frameId: number): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('evaluate', {
                expression: expression,
                frameId: frameId,
                context: 'repl'
            });

            return response;
        } catch (error) {
            throw new Error(`Failed to evaluate expression: ${error}`);
        }
    }


    /**
     * Get all active breakpoints
     */
    public getBreakpoints(): readonly vscode.Breakpoint[] {
        return vscode.debug.breakpoints;
    }

    /**
     * Clear all breakpoints
     */
    public clearAllBreakpoints(): void {
        const breakpoints = vscode.debug.breakpoints;
        if (breakpoints.length > 0) {
            vscode.debug.removeBreakpoints(breakpoints);
        }
    }

    /**
     * Check if there's an active debug session that is ready for debugging operations
     */
    public async hasActiveSession(): Promise<boolean> {
        return vscode.debug.activeDebugSession !== undefined;
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }

    /**
     * Explicitly wait for the active session to stop or terminate.
     *
     * Control commands never call this method implicitly. The bounded wait is
     * exposed separately so MCP callers choose when occupying a request until
     * the debugger becomes actionable.
     */
    public async waitForDebugStop(timeoutMs: number, signal?: AbortSignal): Promise<DebugStopWaitResult> {
        return await this.createDebugStopWait(timeoutMs, signal, true).promise;
    }

    /**
     * Arm next-stop listeners before dispatching a control command.
     *
     * A debugger is normally paused when a step or continue command is issued.
     * Waiting only after dispatch could mistake that pre-command stack frame for
     * the result of the command. Arming first also prevents a fast stop event
     * from landing between command acceptance and listener registration.
     */
    public async executeControlAndWait(
        control: () => Promise<void>,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<DebugStopWaitResult> {
        const wait = this.createDebugStopWait(timeoutMs, signal, false);
        // Observe early cancellation while the VS Code command is still pending.
        void wait.promise.catch(() => undefined);
        if (signal?.aborted) {
            return await wait.promise;
        }

        try {
            await control();
        } catch (error) {
            wait.cancel();
            throw error;
        }

        return await wait.promise;
    }

    private createDebugStopWait(
        timeoutMs: number,
        signal: AbortSignal | undefined,
        includeCurrentStop: boolean
    ): DebugStopWaitHandle {
        const isStoppedWithFrame = (): boolean => {
            const item = vscode.debug.activeStackItem;
            return !!item && 'frameId' in item;
        };

        const trackedSession = vscode.debug.activeDebugSession;
        const subscriptions: vscode.Disposable[] = [];
        let cancel = (): void => { /* initialized by the promise executor */ };

        const promise = new Promise<DebugStopWaitResult>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = (): void => {
                if (timer) {
                    clearTimeout(timer);
                }
                subscriptions.forEach(disposable => disposable.dispose());
                signal?.removeEventListener('abort', onAbort);
            };
            const settle = (result: DebugStopWaitResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                logger.info(`Debug stop wait completed: ${result.outcome}`);
                resolve(result);
            };
            const cancelWait = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                const error = new Error('Debug stop wait cancelled.');
                error.name = 'AbortError';
                reject(error);
            };
            const onAbort = (): void => {
                logger.info('Debug stop wait cancelled by MCP client');
                cancelWait();
            };
            cancel = cancelWait;

            if (signal?.aborted) {
                cancelWait();
                return;
            }
            if (includeCurrentStop && isStoppedWithFrame()) {
                settle({ outcome: 'stopped' });
                return;
            }
            if (!trackedSession) {
                settle({ outcome: 'terminated' });
                return;
            }

            timer = setTimeout(() => {
                settle({ outcome: 'timeout' });
            }, timeoutMs);

            subscriptions.push(
                vscode.debug.onDidChangeActiveStackItem(stackItem => {
                    if (stackItem && 'frameId' in stackItem) {
                        settle({ outcome: 'stopped' });
                    }
                })
            );

            subscriptions.push(
                vscode.debug.onDidTerminateDebugSession(session => {
                    if (session.id === trackedSession.id) {
                        settle({ outcome: 'terminated' });
                    }
                })
            );
            signal?.addEventListener('abort', onAbort, { once: true });

            // Register listeners before re-checking state so an event cannot
            // land between inspection and subscription.
            if (includeCurrentStop && isStoppedWithFrame()) {
                settle({ outcome: 'stopped' });
            } else if (!vscode.debug.activeDebugSession) {
                settle({ outcome: 'terminated' });
            }
        });

        return { promise, cancel };
    }
}
