// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugConfigurationManager, IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState } from './debugState';
import { DebugLaunchResult, DebugSessionDetails, IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath: string; workingDirectory: string; testName?: string; configurationName?: string }): Promise<string>;
    handleStartDebuggingWithConfig(args: { configuration: vscode.DebugConfiguration; workingDirectory: string }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string>;
    handleStepInto(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string>;
    handleStepOut(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string>;
    handleContinue(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string>;
    handleWaitForDebugStop(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string>;
    handleRestart(): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; lineContent: string; condition?: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string>;
    handleEvaluateExpression(args: { expression: string }): Promise<string>;
}

/**
 * Handles debugging operations using the executor and configuration manager
 */
export class DebuggingHandler implements IDebuggingHandler {
    private static readonly MAX_WAIT_TIMEOUT_MS = 300_000;
    private readonly numNextLines: number = 3;
    private readonly timeoutInSeconds: number;

    constructor(
        private readonly executor: IDebuggingExecutor,
        private readonly configManager: IDebugConfigurationManager,
        timeoutInSeconds: number
    ) {
        this.timeoutInSeconds = timeoutInSeconds;
    }

    /**
     * Start a debugging session
     */
    public async handleStartDebugging(args: { 
        fileFullPath: string; 
        workingDirectory: string;
        testName?: string;
        configurationName?: string;
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName, configurationName } = args;
        const hasExplicitConfig = !!configurationName &&
            configurationName.trim() !== '' &&
            configurationName !== DebugConfigurationManager.getAutoLaunchConfigName();
		
        try {
            logger.info(`handleStartDebugging: file=${fileFullPath} test=${testName ?? '<none>'} config=${configurationName ?? '<auto>'}`);

            let launchResult: DebugLaunchResult;
            let configDescription: string;
            let requestedConfigurationName: string;

            if (testName && !hasExplicitConfig) {
                // Route through VS Code's Testing API. This works for any language
                // whose extension registers a TestController and correctly handles
                // child-process attach for runners like `dotnet test`.
                const dispatch = await this.executor.debugTestAtCursor(fileFullPath, testName);
                launchResult = {
                    accepted: dispatch.started,
                    session: this.describeActiveSession(),
                    terminated: false
                };
                // Keep the command completion observed so a rejected Testing API
                // promise is logged by the executor rather than becoming unhandled.
                void dispatch.runComplete;
                configDescription = `testing.debugAtCursor (test: ${testName})`;
                requestedConfigurationName = configDescription;
            } else {
                const debugConfig = await this.configManager.getDebugConfig(
                    workingDirectory,
                    fileFullPath,
                    configurationName
                );
                launchResult = await this.executor.startDebugging(workingDirectory, debugConfig);
                const configName = typeof debugConfig === 'string' ? debugConfig : debugConfig.name;
                configDescription = configName ? `configuration '${configName}'` : 'default configuration';
                requestedConfigurationName = configName ?? 'default configuration';
            }

            if (!launchResult.accepted) {
                throw new Error('Failed to start debug session. Make sure the appropriate language extension is installed.');
            }

            logger.info(`handleStartDebugging: accepted using ${configDescription}`);
            return await this.formatLaunchResult({
                requestedConfigurationName,
                launchResult
            });
        } catch (error) {
            throw new Error(`Error starting debug session: ${error}`);
        }
    }

    /**
     * Start a debugging session from a caller-supplied inline DebugConfiguration.
     *
     * This is the language-agnostic launcher: it forwards the raw config straight
     * to vscode.debug.startDebugging() without injecting any runtime/toolchain
     * opinions. The CALLER owns the specialization — e.g. runtimeExecutable:"tsx"
     * for a .ts file, debugpy fields for Python, "request":"attach"+port for a
     * --inspect-brk process, etc. This keeps the extension a thin shim while still
     * supporting arbitrary programs (and languages) without a launch.json entry.
     */
    public async handleStartDebuggingWithConfig(args: {
        configuration: vscode.DebugConfiguration;
        workingDirectory: string;
    }): Promise<string> {
        const { configuration, workingDirectory } = args;
        try {
            this.validateConfiguration(configuration);
            const label = configuration.name || configuration.program || configuration.type;
            logger.info(
                `handleStartDebuggingWithConfig: type=${configuration.type} ` +
                `request=${configuration.request} program=${configuration.program ?? '<none>'} cwd=${workingDirectory}`
            );

            const launchResult = await this.executor.startDebugging(workingDirectory, configuration);
            if (!launchResult.accepted) {
                throw new Error(
                    'Failed to start debug session. Make sure the appropriate language extension is ' +
                    'installed and the configuration is valid.'
                );
            }

            return await this.formatLaunchResult({
                requestedConfigurationName: label,
                requestedConfiguration: configuration,
                launchResult
            });
        } catch (error) {
            throw new Error(`Error starting debug session: ${error}`);
        }
    }

    /**
     * Minimal validation for an inline DebugConfiguration. We deliberately do NOT
     * validate adapter-specific fields — that is the caller's responsibility — but
     * VS Code requires at least a `type`, a `request`, and a `name`.
     */
    private validateConfiguration(config: vscode.DebugConfiguration): void {
        if (!config || typeof config !== 'object') {
            throw new Error('configuration must be an object (a VS Code DebugConfiguration).');
        }
        if (typeof config.type !== 'string' || config.type.trim() === '') {
            throw new Error("configuration.type is required (e.g. 'node', 'python', 'go', 'coreclr').");
        }
        if (config.request !== 'launch' && config.request !== 'attach') {
            throw new Error("configuration.request must be 'launch' or 'attach'.");
        }
        if (typeof config.name !== 'string' || config.name.trim() === '') {
            // VS Code requires a name; inject a sensible default rather than failing.
            config.name = 'DebugMCP Inline';
        }
    }

    /**
     * Stop the current debugging session
     */
    public async handleStopDebugging(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                return 'No active debug session to stop';
            }

            await this.executor.stopDebugging();

            // Add drill-down reminder
            return 'Debug session stopped successfully\n\n' + this.getRootCauseAnalysisCheckpointMessage();
        } catch (error) {
            throw new Error(`Error stopping debug session: ${error}`);
        }
    }

    /**
     * Clear all breakpoints
     */
    public async handleClearAllBreakpoints(): Promise<string> {
        try {
            const breakpointCount = this.executor.getBreakpoints().length;
            
            if (breakpointCount === 0) {
                return 'No breakpoints to clear';
            }

            this.executor.clearAllBreakpoints();
            return `Successfully cleared ${breakpointCount} breakpoint(s)`;
        } catch (error) {
            throw new Error(`Error clearing breakpoints: ${error}`);
        }
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            return await this.executeControl(
                'step_over',
                () => this.executor.stepOver(),
                args?.timeoutMs,
                signal
            );
        } catch (error) {
            if (this.isAbortError(error)) {
                throw error;
            }
            throw new Error(`Error executing step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            return await this.executeControl(
                'step_into',
                () => this.executor.stepInto(),
                args?.timeoutMs,
                signal
            );
        } catch (error) {
            if (this.isAbortError(error)) {
                throw error;
            }
            throw new Error(`Error executing step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            return await this.executeControl(
                'step_out',
                () => this.executor.stepOut(),
                args?.timeoutMs,
                signal
            );
        } catch (error) {
            if (this.isAbortError(error)) {
                throw error;
            }
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(args?: { timeoutMs?: number }, signal?: AbortSignal): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            return await this.executeControl(
                'continue',
                () => this.executor.continue(),
                args?.timeoutMs,
                signal
            );
        } catch (error) {
            if (this.isAbortError(error)) {
                throw error;
            }
            throw new Error(`Error executing continue: ${error}`);
        }
    }

    /**
     * Explicitly wait for the active debuggee to stop or terminate.
     */
    public async handleWaitForDebugStop(
        args?: { timeoutMs?: number },
        signal?: AbortSignal
    ): Promise<string> {
        const timeoutMs = args?.timeoutMs === undefined
            ? Math.min(this.timeoutInSeconds * 1000, DebuggingHandler.MAX_WAIT_TIMEOUT_MS)
            : this.validateTimeoutMs(args.timeoutMs);

        const result = await this.executor.waitForDebugStop(timeoutMs, signal);
        const state = await this.executor.getCurrentDebugState(this.numNextLines);
        const response: Record<string, unknown> = {
            outcome: result.outcome,
            timeoutMs,
            state: JSON.parse(state.toString())
        };

        if (result.outcome === 'stopped') {
            response.reason = this.inferStopReason(state);
        } else if (result.outcome === 'timeout') {
            response.message = `Debugger did not stop or terminate within ${timeoutMs} ms.`;
        }

        return JSON.stringify(response, null, 2);
    }

    /**
     * Restart the debugging session
     */
    public async handleRestart(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('No active debug session to restart');
            }

            await this.executor.restart();
            return this.formatControlAccepted('restart');
        } catch (error) {
            throw new Error(`Error restarting debug session: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location. An optional condition makes it a
     * conditional breakpoint that only pauses when the expression is true.
     */
    public async handleAddBreakpoint(args: { fileFullPath: string; lineContent: string; condition?: string }): Promise<string> {
        const { fileFullPath, lineContent, condition } = args;
        
        try {
            // Find the line number containing the line content
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            const matchingLineNumbers: number[] = [];
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(lineContent)) {
                    matchingLineNumbers.push(i + 1); // Convert to 1-based line numbers
                }
            }
            
            if (matchingLineNumbers.length === 0) {
                throw new Error(`Could not find any lines containing: ${lineContent}`);
            }
            
            const uri = vscode.Uri.file(fileFullPath);
            
            // Add breakpoints to all matching lines
            for (const lineNumber of matchingLineNumbers) {
                await this.executor.addBreakpoint(uri, lineNumber, condition);
            }
            
            const conditionInfo = condition ? ` (condition: ${condition})` : '';
            if (matchingLineNumbers.length === 1) {
                return `Breakpoint added at ${fileFullPath}:${matchingLineNumbers[0]}${conditionInfo}`;
            } else {
                const linesList = matchingLineNumbers.join(', ');
                return `Breakpoints added at ${matchingLineNumbers.length} locations in ${fileFullPath}: lines ${linesList}${conditionInfo}`;
            }
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
        const { fileFullPath, line } = args;
        
        try {
            const uri = vscode.Uri.file(fileFullPath);
            
            // Check if breakpoint exists at this location
            const breakpoints = this.executor.getBreakpoints();
            const existingBreakpoint = breakpoints.find(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (!existingBreakpoint) {
                return `No breakpoint found at ${fileFullPath}:${line}`;
            }
            
            await this.executor.removeBreakpoint(uri, line);
            return `Breakpoint removed from ${fileFullPath}:${line}`;
        } catch (error) {
            throw new Error(`Error removing breakpoint: ${error}`);
        }
    }

    /**
     * List all active breakpoints
     */
    public async handleListBreakpoints(): Promise<string> {
        try {
            const breakpoints = this.executor.getBreakpoints();
            
            if (breakpoints.length === 0) {
                return 'No breakpoints currently set';
            }

            let breakpointList = 'Active Breakpoints:\n';
            breakpoints.forEach((bp, index) => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop();
                    const line = bp.location.range.start.line + 1;
                    const conditionInfo = bp.condition ? ` (condition: ${bp.condition})` : '';
                    breakpointList += `${index + 1}. ${fileName}:${line}${conditionInfo}\n`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    breakpointList += `${index + 1}. Function: ${bp.functionName}\n`;
                }
            });

            return breakpointList;
        } catch (error) {
            throw new Error(`Error listing breakpoints: ${error}`);
        }
    }

    /**
     * Get variables from current debug context
     */
    public async handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string> {
        const { scope = 'all' } = args;
        
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Start debugging first and ensure execution is paused.');
            }

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const variablesData = await this.executor.getVariables(activeStackItem.frameId, scope);
            
            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            let variablesInfo = 'Variables:\n==========\n\n';

            for (const scopeItem of variablesData.scopes) {
                variablesInfo += `${scopeItem.name}:\n`;
                
                if (scopeItem.error) {
                    variablesInfo += `  Error retrieving variables: ${scopeItem.error}\n`;
                } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                    for (const variable of scopeItem.variables) {
                        variablesInfo += `  ${variable.name}: ${variable.value}`;
                        if (variable.type) {
                            variablesInfo += ` (${variable.type})`;
                        }
                        variablesInfo += '\n';
                    }
                } else {
                    variablesInfo += '  No variables in this scope\n';
                }
                
                variablesInfo += '\n';
            }

            return variablesInfo;
        } catch (error) {
            throw new Error(`Error getting variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in current debug context
     */
    public async handleEvaluateExpression(args: { expression: string }): Promise<string> {
        const { expression } = args;
        
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Start debugging first and ensure execution is paused.');
            }

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const response = await this.executor.evaluateExpression(expression, activeStackItem.frameId);

            if (response && response.result !== undefined) {
                let resultText = `Expression: ${expression}\n`;
                resultText += `Result: ${response.result}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }

                return resultText;
            } else {
                throw new Error('Failed to evaluate expression');
            }
        } catch (error) {
            throw new Error(`Error evaluating expression: ${error}`);
        }
    }

    /**
     * Get current debug state
     */
    public async getCurrentDebugState(): Promise<DebugState> {
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Check if debugging session is active
     */
    public async isDebuggingActive(): Promise<boolean> {
        return await this.executor.hasActiveSession();
    }

    private async formatLaunchResult(args: {
        requestedConfigurationName: string;
        requestedConfiguration?: vscode.DebugConfiguration;
        launchResult: DebugLaunchResult;
    }): Promise<string> {
        const state = await this.executor.getCurrentDebugState(this.numNextLines);
        const session = args.launchResult.session ?? this.describeActiveSession();
        const currentState = args.launchResult.terminated
            ? 'terminated'
            : state.hasValidContext()
                ? 'paused'
                : session || state.sessionActive
                    ? 'running'
                    : 'starting';

        return JSON.stringify({
            requestedConfigurationName: args.requestedConfigurationName,
            requestedConfiguration: args.requestedConfiguration
                ? this.sanitizeConfiguration(args.requestedConfiguration)
                : undefined,
            actualConfiguration: session
                ? this.sanitizeConfiguration(session.configuration)
                : undefined,
            accepted: args.launchResult.accepted,
            session: session
                ? { id: session.id, name: session.name, type: session.type }
                : undefined,
            state: currentState,
            stoppedState: currentState === 'paused' ? JSON.parse(state.toString()) : undefined
        }, null, 2);
    }

    private describeActiveSession(): DebugSessionDetails | undefined {
        const session = this.executor.getActiveSession();
        if (!session) {
            return undefined;
        }
        return {
            id: session.id,
            name: session.name,
            type: session.type,
            configuration: session.configuration
        };
    }

    private formatControlAccepted(command: string): string {
        const session = this.describeActiveSession();
        return JSON.stringify({
            command,
            accepted: true,
            session: session
                ? { id: session.id, name: session.name, type: session.type }
                : undefined,
            state: 'running',
            message: 'Command accepted. Use wait_for_debug_stop to wait for a pause or termination.'
        }, null, 2);
    }

    private async executeControl(
        command: string,
        control: () => Promise<void>,
        requestedTimeoutMs: number | undefined,
        signal: AbortSignal | undefined
    ): Promise<string> {
        if (requestedTimeoutMs === undefined) {
            await control();
            return this.formatControlAccepted(command);
        }

        const timeoutMs = this.validateTimeoutMs(requestedTimeoutMs);
        const result = await this.executor.executeControlAndWait(control, timeoutMs, signal);
        const state = await this.executor.getCurrentDebugState(this.numNextLines);
        const session = this.describeActiveSession();
        const response: Record<string, unknown> = {
            command,
            accepted: true,
            timeoutMs,
            outcome: result.outcome,
            session: session
                ? { id: session.id, name: session.name, type: session.type }
                : undefined,
            state: JSON.parse(state.toString())
        };

        if (result.outcome === 'stopped') {
            response.reason = this.inferStopReason(state);
        } else if (result.outcome === 'timeout') {
            response.message =
                `Command was accepted, but the debugger did not stop or terminate within ${timeoutMs} ms.`;
        }

        return JSON.stringify(response, null, 2);
    }

    private validateTimeoutMs(timeoutMs: number): number {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new Error('timeoutMs must be a positive integer.');
        }
        if (timeoutMs > DebuggingHandler.MAX_WAIT_TIMEOUT_MS) {
            throw new Error(`timeoutMs must not exceed ${DebuggingHandler.MAX_WAIT_TIMEOUT_MS}.`);
        }
        return timeoutMs;
    }

    private isAbortError(error: unknown): error is Error {
        return error instanceof Error && error.name === 'AbortError';
    }

    private inferStopReason(state: DebugState): string {
        if (state.fileName && state.currentLine !== null) {
            const location = `${state.fileName}:${state.currentLine}`;
            if (state.breakpoints.some(breakpoint => breakpoint.startsWith(location))) {
                return 'breakpoint';
            }
        }
        return 'paused';
    }

    private sanitizeConfiguration(configuration: vscode.DebugConfiguration): unknown {
        const sanitize = (value: unknown, parentKey?: string): unknown => {
            if (Array.isArray(value)) {
                return value.map(item => sanitize(item, parentKey));
            }
            if (!value || typeof value !== 'object') {
                return value;
            }

            const result: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                if (/token|password|secret|authorization|cookie|private.?key/i.test(key)) {
                    result[key] = '[redacted]';
                } else if (parentKey === 'env') {
                    result[key] = '[redacted]';
                } else {
                    result[key] = sanitize(child, key);
                }
            }
            return result;
        };

        return sanitize(configuration);
    }

    /**
     * Get the universal drill-down reminder message
     */
    private getRootCauseAnalysisCheckpointMessage(): string {
        return `⚠️ **ROOT CAUSE ANALYSIS CHECKPOINT**

Before concluding your debugging session:

❓ **CRITICAL QUESTION:** Have you found the ROOT CAUSE or just a SYMPTOM?

🔍 **If you only identified WHERE it went wrong:**
- Variable is null/undefined
- Function returned unexpected value  
- Error occurred at specific line
- Condition evaluated incorrectly

➡️ **You likely found a SYMPTOM - Continue debugging!**

ROOT CAUSE means understanding WHY the issue occurred in the first place, for example due to:
- Incorrect variable initialization
- Logic error in function implementation
- Missing error handling
- Faulty assumptions in conditions

REQUIRED NEXT STEPS:
1. Use 'add_breakpoint' to set breakpoints at investigation points
2. Use 'start_debugging' to trace from the beginning
3. Investigate WHY the issue occurred, not just WHAT happened
4. Repeat the process as necessary until the ROOT CAUSE is identified`;
    }
}
