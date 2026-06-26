// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DebugMCPServer } from './debugMCPServer';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger, LogLevel } from './utils/logger';

let mcpServer: DebugMCPServer | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;
let editorMcpRegistration: vscode.Disposable | null = null;

const AUTH_TOKEN_SECRET_KEY = 'debugmcp.authToken';

/**
 * Get (or lazily mint + persist) the per-install auth token. Stored in
 * SecretStorage so it is stable across reloads — config files and registered
 * server definitions reference the same token.
 */
async function getOrCreateAuthToken(context: vscode.ExtensionContext): Promise<string> {
    let token = await context.secrets.get(AUTH_TOKEN_SECRET_KEY);
    if (!token) {
        token = randomUUID();
        await context.secrets.store(AUTH_TOKEN_SECRET_KEY, token);
        logger.info('Minted a new DebugMCP auth token');
    }
    return token;
}

/**
 * Register the running HTTP MCP server with the host editor's native API so the
 * auth token is delivered to the editor's built-in MCP client without the user
 * editing any config file.
 *
 * - VS Code (and forks implementing the API): vscode.lm.registerMcpServerDefinitionProvider
 *   with an McpHttpServerDefinition carrying an Authorization header.
 * - Cursor: vscode.cursor.mcp.registerServer. Cursor currently drops custom
 *   headers passed this way (https://github.com/cursor/cursor/issues/3536), so
 *   the token is also carried in the URL query, which the server accepts.
 *
 * Returns a Disposable that unregisters, or null if no native API is available
 * (in which case the agent config-file path provides the token instead).
 */
function registerWithEditor(baseUrl: string, token: string): vscode.Disposable | null {
    const anyVscode = vscode as any;
    const authHeader = { Authorization: `Bearer ${token}` };

    // VS Code native MCP provider API (typed; supports headers reliably).
    const lm = anyVscode.lm;
    if (lm && typeof lm.registerMcpServerDefinitionProvider === 'function' && anyVscode.McpHttpServerDefinition) {
        try {
            const provider = {
                provideMcpServerDefinitions: async () => [
                    new anyVscode.McpHttpServerDefinition('DebugMCP', vscode.Uri.parse(baseUrl), authHeader)
                ],
                resolveMcpServerDefinition: async (server: any) => server
            };
            const disposable: vscode.Disposable = lm.registerMcpServerDefinitionProvider('debugmcp.serverProvider', provider);
            logger.info('Registered DebugMCP via the VS Code MCP provider API (header auth)');
            return disposable;
        } catch (error) {
            logger.warn('VS Code MCP provider registration failed; falling back to config files', error);
        }
    }

    // Cursor extension API.
    const cursorMcp = anyVscode.cursor?.mcp;
    if (cursorMcp && typeof cursorMcp.registerServer === 'function') {
        try {
            const urlWithToken = `${baseUrl}?token=${encodeURIComponent(token)}`;
            cursorMcp.registerServer({
                name: 'debugmcp',
                server: { url: urlWithToken, headers: authHeader }
            });
            logger.info('Registered DebugMCP via the Cursor MCP extension API (query-param auth)');
            return new vscode.Disposable(() => {
                try {
                    cursorMcp.unregisterServer?.('debugmcp');
                } catch (error) {
                    logger.warn('Failed to unregister DebugMCP from Cursor', error);
                }
            });
        } catch (error) {
            logger.warn('Cursor MCP registration failed; falling back to config files', error);
        }
    }

    return null;
}

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('DebugMCP extension is now active!');
    logger.logSystemInfo();
    logger.logEnvironment();

    const config = vscode.workspace.getConfiguration('debugmcp');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 180);
    const serverPort = config.get<number>('serverPort', 3001);
    const bindHostSetting = config.get<string | string[]>('bindHost', ['127.0.0.1', '::1']);
    const bindHosts = Array.isArray(bindHostSetting) ? bindHostSetting : [bindHostSetting];

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    logger.info(`Using bindHost: ${bindHosts.join(', ')}`);
    const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
    const nonLoopback = bindHosts.filter(h => !loopbackHosts.has(h));
    if (nonLoopback.length > 0) {
        logger.warn(
            `DebugMCP is bound to '${nonLoopback.join(', ')}' instead of loopback. ` +
            `The server requires an auth token, but exposing the debugger to other hosts ` +
            `still widens the attack surface. Set 'debugmcp.bindHost' back to the default ` +
            `loopback unless you fully trust the network.`
        );
    }

    // Mint/load the auth token before configuring anything that needs it.
    const authToken = await getOrCreateAuthToken(context);

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort, authToken);

    // Migrate existing SSE configurations to streamableHttp (for backward compatibility)
    try {
        await agentConfigManager.migrateExistingConfigurations();
    } catch (error) {
        logger.error('Error migrating existing configurations', error);
    }

    // Initialize MCP Server
    try {
        logger.info('Starting MCP server initialization...');
        
        mcpServer = new DebugMCPServer(serverPort, timeoutInSeconds, bindHosts, authToken);
        await mcpServer.initialize();
        await mcpServer.start();
        
        const endpoint = mcpServer.getEndpoint();
        logger.info(`DebugMCP server running at: ${endpoint}`);

        // Deliver the token to the host editor's MCP client via its native API.
        editorMcpRegistration = registerWithEditor(`${endpoint}/mcp`, authToken);
        if (editorMcpRegistration) {
            context.subscriptions.push(editorMcpRegistration);
        }

        const hasShownRunningMessage = context.globalState.get<boolean>('serverRunningMessageShown', false);
        if (!hasShownRunningMessage) {
            vscode.window.showInformationMessage(`DebugMCP server running on ${endpoint}`);
            await context.globalState.update('serverRunningMessageShown', true);
        }
    } catch (error) {
        logger.error('Failed to initialize MCP server', error);
        vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
    }

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    setTimeout(async () => {
        try {
            if (agentConfigManager && await agentConfigManager.shouldShowPopup()) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        } catch (error) {
            logger.error('Error showing post-install popup', error);
        }
    }, 2000);

    logger.info('DebugMCP extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure DebugMCP for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'debugmcp.configureAgents',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'debugmcp.showAgentSelectionPopup',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'debugmcp.resetPopupState',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.resetPopupState();
                vscode.window.showInformationMessage('DebugMCP popup state has been reset.');
            }
        }
    );

    context.subscriptions.push(
        configureAgentsCommand,
        showPopupCommand,
        resetPopupCommand
        );
}

export async function deactivate() {
    logger.info('DebugMCP extension deactivating...');

    // Unregister from the host editor's MCP client
    if (editorMcpRegistration) {
        try {
            editorMcpRegistration.dispose();
        } catch (error) {
            logger.error('Error disposing editor MCP registration', error);
        }
        editorMcpRegistration = null;
    }

    // Clean up MCP server
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            logger.error('Error stopping MCP server', error);
        });
        mcpServer = null;
    }
    
    logger.info('DebugMCP extension deactivated');
}
