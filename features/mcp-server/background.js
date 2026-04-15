/**
 * MCP Server Extension Background Script
 *
 * Registers the "mcp server setup" command which provides instructions
 * for configuring Claude Code to use Peek as an MCP server.
 */

const api = typeof window !== 'undefined' ? window.app : null;

const extension = {
  id: 'mcp-server',

  init() {
    if (!api) return;

    api.commands.register({
      name: 'mcp server setup',
      description: 'Configure Claude Code to use Peek as an MCP server',
      execute: async () => {
        const serverPath = 'features/mcp-server/server.js';
        const setupPath = 'features/mcp-server/setup.js';

        return {
          success: true,
          output: [
            'Peek MCP Server Setup',
            '',
            'Run the setup script to configure Claude Code:',
            `  node ${setupPath}`,
            '',
            'Or add manually to ~/.claude/settings.json:',
            '',
            '  "mcpServers": {',
            '    "peek": {',
            '      "command": "node",',
            `      "args": ["<path-to-peek>/${serverPath}"],`,
            '      "env": {',
            '        "PEEK_DB_PATH": "~/Library/Application Support/Peek/default/datastore.sqlite"',
            '      }',
            '    }',
            '  }',
            '',
            'Then restart Claude Code.',
          ].join('\n'),
        };
      },
    });
  },

  uninit() {
    if (!api) return;
    api.commands.unregister('mcp server setup');
  },
};

export default extension;
