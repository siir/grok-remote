// Curated registry of well-known MCP servers used to populate the
// "Browse registry" picker on the MCP settings page.

export interface McpRegistryEnvVar {
  name: string;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface McpRegistryEntry {
  name: string;
  slug: string;
  description: string;
  category: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: McpRegistryEnvVar[];
  url_docs?: string;
  official: boolean;
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  // Official @modelcontextprotocol reference servers.
  {
    name: 'everything',
    slug: 'everything',
    description: 'Reference server exercising every MCP feature (testing/demo).',
    category: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    official: true,
  },
  {
    name: 'fetch',
    slug: 'fetch',
    description: 'Fetch and convert web content to markdown.',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    official: true,
  },
  {
    name: 'filesystem',
    slug: 'filesystem',
    description: 'Secure file operations scoped to an allowed root directory.',
    category: 'development',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    official: true,
  },
  {
    name: 'git',
    slug: 'git',
    description: 'Read, search, and manipulate git repositories.',
    category: 'development',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    official: true,
  },
  {
    name: 'memory',
    slug: 'memory',
    description: 'Knowledge-graph persistent memory across sessions.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    official: true,
  },
  {
    name: 'sequential-thinking',
    slug: 'sequential-thinking',
    description: 'Structured step-by-step reasoning tool.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequentialthinking'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    official: true,
  },
  {
    name: 'time',
    slug: 'time',
    description: 'Current time and timezone conversion utilities.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    official: true,
  },

  // Vendor-official / well-known integrations.
  {
    name: 'github',
    slug: 'github',
    description: 'Read and write GitHub repositories, issues, and pull requests.',
    category: 'development',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{
      name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      required: true,
      placeholder: 'ghp_...',
      help: 'Personal access token with repo scope.',
    }],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    official: true,
  },
  {
    name: 'postgres',
    slug: 'postgres',
    description: 'Read-only Postgres access (schema introspection plus SELECT).',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@host:5432/db'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    official: true,
  },
  {
    name: 'slack',
    slug: 'slack',
    description: 'Read and post messages in Slack workspaces.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: [
      { name: 'SLACK_BOT_TOKEN', required: true, placeholder: 'xoxb-...' },
      { name: 'SLACK_TEAM_ID',   required: true, placeholder: 'T01234567' },
    ],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    official: true,
  },
  {
    name: 'google-drive',
    slug: 'google-drive',
    description: 'Search and read files from Google Drive.',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    env: [{
      name: 'GDRIVE_CREDENTIALS_PATH',
      required: true,
      placeholder: '/path/to/credentials.json',
      help: 'Path to OAuth credentials JSON downloaded from Google Cloud Console.',
    }],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
    official: true,
  },
  {
    name: 'brave-search',
    slug: 'brave-search',
    description: 'Web and local search via the Brave Search API.',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: [{
      name: 'BRAVE_API_KEY',
      required: true,
      placeholder: 'BSA...',
      help: 'API key from api.search.brave.com.',
    }],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    official: true,
  },
  {
    name: 'puppeteer',
    slug: 'puppeteer',
    description: 'Headless Chrome browser automation (navigation, screenshots, scraping).',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    official: true,
  },
  {
    name: 'sqlite',
    slug: 'sqlite',
    description: 'Query a local SQLite database file.',
    category: 'data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '/path/to/database.db'],
    url_docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    official: true,
  },
  {
    name: 'playwright',
    slug: 'playwright',
    description: 'Cross-browser automation maintained by Microsoft.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    url_docs: 'https://github.com/microsoft/playwright-mcp',
    official: true,
  },
  {
    name: 'notion',
    slug: 'notion',
    description: 'Read and write Notion pages and databases.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: [{
      name: 'NOTION_API_KEY',
      required: true,
      placeholder: 'secret_...',
      help: 'Internal integration secret from notion.so/my-integrations.',
    }],
    url_docs: 'https://github.com/makenotion/notion-mcp-server',
    official: true,
  },
];

export const MCP_CATEGORIES: string[] = [
  'development',
  'data',
  'search',
  'productivity',
  'browser',
  'demo',
];
