// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DebugMCPServer } from '../debugMCPServer';

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

suite('DebugMCPServer request cancellation', () => {
    test('aborts an in-flight tool handler after dispatch', async () => {
        const debugServer = new DebugMCPServer(0, 60);
        const handlerStarted = deferred<void>();
        const handlerCancelled = deferred<void>();
        let handlerSignal: AbortSignal | undefined;

        debugServer.getDebuggingHandler().handleWaitForDebugStop = async (_args, signal) => {
            assert.ok(signal, 'MCP SDK did not provide a request cancellation signal');
            handlerSignal = signal;
            handlerStarted.resolve();

            return await new Promise<string>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    handlerCancelled.resolve();
                    const error = new Error('Debug stop wait cancelled.');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        };

        const mcpServer = (
            debugServer as unknown as { createMcpServer(): McpServer }
        ).createMcpServer();
        const client = new Client({ name: 'cancellation-test', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([
            mcpServer.connect(serverTransport),
            client.connect(clientTransport)
        ]);

        try {
            const controller = new AbortController();
            const request = client.callTool(
                {
                    name: 'wait_for_debug_stop',
                    arguments: { timeoutMs: 60_000 }
                },
                undefined,
                {
                    signal: controller.signal,
                    timeout: 65_000
                }
            );
            const requestRejected = assert.rejects(request);

            await handlerStarted.promise;
            assert.strictEqual(handlerSignal?.aborted, false);

            controller.abort('test cancellation after dispatch');

            await handlerCancelled.promise;
            assert.strictEqual(handlerSignal?.aborted, true);
            await requestRejected;
        } finally {
            await client.close();
            await mcpServer.close();
        }
    });

});
