// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DebugMCPServer } from '../debugMCPServer';

suite('DebugMCPServer ping', () => {
    test('responds to the standard MCP ping request', async () => {
        const debugServer = new DebugMCPServer(0, 60);
        const mcpServer = (
            debugServer as unknown as { createMcpServer(): McpServer }
        ).createMcpServer();
        const client = new Client({ name: 'ping-test', version: '0.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([
            mcpServer.connect(serverTransport),
            client.connect(clientTransport)
        ]);

        try {
            const result = await client.ping({ timeout: 1_000 });
            assert.deepStrictEqual(result, {});
        } finally {
            await client.close();
            await mcpServer.close();
        }
    });
});
