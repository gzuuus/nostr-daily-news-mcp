import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SimplePool } from 'nostr-tools/pool';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools';
import Parser from 'rss-parser';
import * as fs from 'fs';
import * as path from 'path';

useWebSocketImplementation(WebSocket);

const pool = new SimplePool();
const DEFAULT_LIMIT = 10;
const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const CONFIG_EXAMPLE_PATH = path.resolve(__dirname, '../config.example.json');

// Config types
interface RelayConfig {
  trending: string[];
  news: string[];
  custom: string[];
  [key: string]: string[];
}

interface HackerNewsConfig {
  newest: string;
  frontpage: string;
  bestComments: string;
  ask: string;
  show: string;
  [key: string]: string;
}

interface RssFeedsConfig {
  stackerNews: string;
  hackerNews: HackerNewsConfig;
  custom: Record<string, string>;
  [key: string]: string | HackerNewsConfig | Record<string, string>;
}

interface Config {
  relays: RelayConfig;
  rssFeeds: RssFeedsConfig;
}

// Default configuration
const DEFAULT_CONFIG: Config = {
  relays: {
    trending: ['wss://algo.utxo.one'],
    news: ['wss://news.utxo.one'],
    custom: [],
  },
  rssFeeds: {
    stackerNews: 'https://stacker.news/rss',
    hackerNews: {
      newest: 'https://hnrss.org/newest',
      frontpage: 'https://hnrss.org/frontpage',
      bestComments: 'https://hnrss.org/bestcomments',
      ask: 'https://hnrss.org/ask',
      show: 'https://hnrss.org/show',
    },
    custom: {},
  },
};

function loadConfig(): Config {
  try {
    // Check if config file exists
    if (fs.existsSync(CONFIG_PATH)) {
      const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(configData) as Config;
    }

    // If config doesn't exist, check for example config
    if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      console.error('Config file not found. Creating from example...');
      const exampleConfigData = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8');
      const exampleConfig = JSON.parse(exampleConfigData) as Config;

      // Save the example config as the new config file
      saveConfig(exampleConfig);
      return exampleConfig;
    }

    // If neither exists, use defaults
    console.error(
      'No config or example config found. Creating with defaults...'
    );
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  } catch (error) {
    console.error('Error loading configuration:', error);
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

// Save configuration
function saveConfig(config: Config): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving configuration:', error);
  }
}

// Global configuration
let CONFIG = loadConfig();

const rssParser = new Parser();

async function fetchEvents(
  relays: string[],
  filter: Filter = { limit: DEFAULT_LIMIT }
): Promise<NostrEvent[]> {
  if (!filter.limit) {
    filter.limit = DEFAULT_LIMIT;
  }

  const events = await pool.querySync(relays, filter);
  return events.sort((a, b) => b.created_at - a.created_at);
}

async function fetchTrendingNotes(
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  return fetchEvents(CONFIG.relays.trending, { limit });
}

async function fetchNewsNotes(
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  return fetchEvents(CONFIG.relays.news, { limit });
}

async function fetchCustomRelayNotes(
  relayName: string,
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  if (relayName === 'trending') {
    return fetchTrendingNotes(limit);
  } else if (relayName === 'news') {
    return fetchNewsNotes(limit);
  } else if (CONFIG.relays[relayName]) {
    return fetchEvents(CONFIG.relays[relayName], { limit });
  } else {
    throw new Error(`Relay group '${relayName}' not found in configuration`);
  }
}

interface FormattedItem {
  date: string;
  title: string;
  author: string;
  content: string;
  link?: string;
  metadata?: Record<string, string>;
}

function formatDate(timestamp: number | string | Date): string {
  const date =
    typeof timestamp === 'number'
      ? new Date(timestamp * 1000)
      : new Date(timestamp);
  return date.toISOString();
}

function nostrEventToFormattedItem(event: NostrEvent): FormattedItem {
  return {
    date: formatDate(event.created_at),
    title: '', // Nostr events don't have titles
    author: event.pubkey ? `${event.pubkey.substring(0, 8)}...` : '',
    content: event.content,
    metadata:
      event.kind !== undefined ? { kind: String(event.kind) } : undefined,
  };
}

function rssItemToFormattedItem(item: Parser.Item): FormattedItem {
  return {
    date: item.pubDate ? formatDate(item.pubDate) : 'Unknown date',
    title: item.title || '',
    author: item.creator || '',
    content: item.contentSnippet || '',
    link: item.link || '',
    metadata: item.categories?.length
      ? { categories: item.categories.join(', ') }
      : undefined,
  };
}

function formatItem(item: FormattedItem): string {
  let output = `[${item.date}]`;

  if (item.title) {
    output += ` ${item.title}`;
  }

  if (item.author) {
    output += `\nAuthor: ${item.author}`;
  }

  if (item.metadata) {
    for (const [key, value] of Object.entries(item.metadata)) {
      if (value) {
        output += `\n${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`;
      }
    }
  }

  if (item.content) {
    output += `\n${item.content}`;
  }

  if (item.link) {
    output += `\n${item.link}`;
  }

  return output;
}

function formatNostrEvent(event: NostrEvent): string {
  return formatItem(nostrEventToFormattedItem(event));
}

async function fetchRssFeed(
  feedUrl: string,
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return feed.items.slice(0, limit);
  } catch (error) {
    console.error(`Error fetching RSS feed from ${feedUrl}:`, error);
    throw error;
  }
}

async function fetchStackerNews(
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  return fetchRssFeed(CONFIG.rssFeeds.stackerNews as string, limit);
}

async function fetchHackerNews(
  type: keyof typeof CONFIG.rssFeeds.hackerNews = 'newest',
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  const hackerNews = CONFIG.rssFeeds.hackerNews as HackerNewsConfig;
  return fetchRssFeed(hackerNews[type] as string, limit);
}

async function fetchCustomRssFeed(
  feedName: string,
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  if (feedName === 'stackerNews') {
    return fetchStackerNews(limit);
  } else if (feedName.startsWith('hackerNews.')) {
    const type = feedName.split(
      '.'
    )[1] as keyof typeof CONFIG.rssFeeds.hackerNews;
    return fetchHackerNews(type, limit);
  } else {
    const customFeeds = CONFIG.rssFeeds.custom as Record<string, string>;
    if (customFeeds[feedName]) {
      return fetchRssFeed(customFeeds[feedName], limit);
    } else {
      throw new Error(`RSS feed '${feedName}' not found in configuration`);
    }
  }
}

function formatRssItem(item: Parser.Item): string {
  return formatItem(rssItemToFormattedItem(item));
}

function handleToolError(error: unknown, errorPrefix: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

function createToolHandler<T>(
  fetchFunction: (limit: number, ...args: any[]) => Promise<T[]>,
  formatFunction: (item: T) => string,
  notFoundMessage: string,
  errorPrefix: string
) {
  return async (params: any, extra: any) => {
    try {
      const { limit, ...otherParams } = params;

      const items = await fetchFunction(limit, ...Object.values(otherParams));

      if (items.length === 0) {
        return {
          content: [{ type: 'text' as const, text: notFoundMessage }],
        };
      }

      const formattedItems = items.map(formatFunction);

      return {
        content: [
          {
            type: 'text' as const,
            text: formattedItems.join('\n\n'),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error, errorPrefix);
    }
  };
}

function createNotesToolHandler(
  fetchFunction: (limit: number) => Promise<NostrEvent[]>,
  notFoundMessage: string
) {
  return createToolHandler<NostrEvent>(
    fetchFunction,
    formatNostrEvent,
    notFoundMessage,
    'Error fetching notes'
  );
}

function createRssToolHandler(
  fetchFunction: (limit: number) => Promise<Parser.Item[]>,
  notFoundMessage: string
) {
  return createToolHandler<Parser.Item>(
    fetchFunction,
    formatRssItem,
    notFoundMessage,
    'Error fetching RSS feed'
  );
}

async function startServer() {
  const server = new McpServer({
    name: 'Nostr Daily News',
    version: '1.0.0',
  });

  const notesSchema = { limit: z.number().optional().default(DEFAULT_LIMIT) };

  server.tool(
    'fetch-trending-notes',
    'Fetch trending notes from nostr',
    notesSchema,
    createNotesToolHandler(fetchTrendingNotes, 'No trending notes found.')
  );

  server.tool(
    'fetch-news-notes',
    'Fetch latest news from nostr',
    notesSchema,
    createNotesToolHandler(fetchNewsNotes, 'No news notes found.')
  );

  server.tool(
    'fetch-custom-events',
    'Fetch Nostr events with custom filters from specified relay URLs',
    {
      relays: z.array(z.string()),
      limit: z.number().optional().default(DEFAULT_LIMIT),
      kinds: z.array(z.number()).optional(),
      authors: z.array(z.string()).optional(),
      since: z.number().optional(),
      until: z.number().optional(),
    },
    async ({ relays, limit, kinds, authors, since, until }) => {
      try {
        const filter: Filter = { limit };
        if (kinds) filter.kinds = kinds;
        if (authors) filter.authors = authors;
        if (since) filter.since = since;
        if (until) filter.until = until;

        const events = await fetchEvents(relays, filter);

        if (events.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No events found for the specified filter.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: events.map(formatNostrEvent).join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error fetching events');
      }
    }
  );

  server.tool(
    'fetch-relay-group',
    'Fetch notes from a configured relay group',
    {
      relayGroup: z.string(),
      limit: z.number().optional().default(DEFAULT_LIMIT),
    },
    async ({ relayGroup, limit }) => {
      try {
        const events = await fetchCustomRelayNotes(relayGroup, limit);

        if (events.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No events found for relay group '${relayGroup}'.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: events.map(formatNostrEvent).join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error fetching events from relay group');
      }
    }
  );

  server.tool(
    'fetch-stacker-news',
    'Fetch latest news and discussions from Stacker News RSS feed',
    notesSchema,
    createRssToolHandler(fetchStackerNews, 'No Stacker News items found.')
  );

  server.tool(
    'fetch-hacker-news',
    'Fetch latest news and discussions from Hacker News RSS feed',
    {
      limit: z.number().optional().default(DEFAULT_LIMIT),
      type: z
        .enum(['newest', 'frontpage', 'bestComments', 'ask', 'show'])
        .optional()
        .default('newest'),
    },
    // Use a specialized handler for Hacker News that can handle the type parameter
    async ({ limit, type }, extra: any) => {
      try {
        const items = await fetchHackerNews(type, limit);

        if (items.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No Hacker News items found.' },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: items.map(formatRssItem).join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error fetching Hacker News RSS feed');
      }
    }
  );

  server.tool(
    'fetch-custom-rss',
    'Fetch news from a custom RSS feed',
    {
      feedName: z.string(),
      limit: z.number().optional().default(DEFAULT_LIMIT),
    },
    async ({ feedName, limit }) => {
      try {
        const items = await fetchCustomRssFeed(feedName, limit);

        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No items found for RSS feed '${feedName}'.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: items.map(formatRssItem).join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error fetching custom RSS feed');
      }
    }
  );

  // Configuration management tools
  server.tool('get-config', 'Get the current configuration', {}, async () => {
    try {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(CONFIG, null, 2),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error, 'Error retrieving configuration');
    }
  });

  server.tool(
    'add-relay-group',
    'Add a new relay group to the configuration',
    {
      name: z.string(),
      relays: z.array(z.string()),
    },
    async ({ name, relays }) => {
      try {
        if (name === 'custom') {
          // Add to custom array
          CONFIG.relays.custom = [...CONFIG.relays.custom, ...relays];
        } else {
          // Create or update named group
          CONFIG.relays[name] = relays;
        }

        saveConfig(CONFIG);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Relay group '${name}' has been added/updated with ${relays.length} relays.`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error adding relay group');
      }
    }
  );

  server.tool(
    'add-rss-feed',
    'Add a new RSS feed to the configuration',
    {
      name: z.string(),
      url: z.string(),
    },
    async ({ name, url }) => {
      try {
        // Test that the feed is valid
        await rssParser.parseURL(url);

        // Add to custom feeds
        const customFeeds = CONFIG.rssFeeds.custom as Record<string, string>;
        customFeeds[name] = url;

        saveConfig(CONFIG);

        return {
          content: [
            {
              type: 'text' as const,
              text: `RSS feed '${name}' has been added with URL: ${url}`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error adding RSS feed');
      }
    }
  );

  server.tool(
    'list-relay-groups',
    'List all available relay groups',
    {},
    async () => {
      try {
        const groups = Object.entries(CONFIG.relays).map(([name, relays]) => {
          return `${name}: ${Array.isArray(relays) ? relays.join(', ') : 'Invalid relay group'}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: groups.join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error listing relay groups');
      }
    }
  );

  server.tool(
    'list-rss-feeds',
    'List all available RSS feeds',
    {},
    async () => {
      try {
        const feeds: string[] = [];

        // Add stackerNews
        feeds.push(`stackerNews: ${CONFIG.rssFeeds.stackerNews}`);

        // Add hackerNews feeds
        const hackerNews = CONFIG.rssFeeds.hackerNews as HackerNewsConfig;
        Object.entries(hackerNews).forEach(([type, url]) => {
          feeds.push(`hackerNews.${type}: ${url}`);
        });

        // Add custom feeds
        const customFeeds = CONFIG.rssFeeds.custom as Record<string, string>;
        Object.entries(customFeeds).forEach(([name, url]) => {
          feeds.push(`${name}: ${url}`);
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: feeds.join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error listing RSS feeds');
      }
    }
  );

  server.tool(
    'remove-relay-group',
    'Remove a relay group from the configuration',
    {
      name: z.string(),
    },
    async ({ name }) => {
      try {
        if (name === 'trending' || name === 'news') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot remove built-in relay group '${name}'. You can update it instead.`,
              },
            ],
          };
        }

        if (name === 'custom') {
          CONFIG.relays.custom = [];
        } else if (CONFIG.relays[name]) {
          delete CONFIG.relays[name];
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Relay group '${name}' not found.`,
              },
            ],
          };
        }

        saveConfig(CONFIG);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Relay group '${name}' has been removed.`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error, 'Error removing relay group');
      }
    }
  );

  server.tool(
    'remove-rss-feed',
    'Remove an RSS feed from the configuration',
    {
      name: z.string(),
    },
    async ({ name }) => {
      try {
        if (name === 'stackerNews' || name.startsWith('hackerNews.')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot remove built-in RSS feed '${name}'. You can update it instead.`,
              },
            ],
          };
        }

        const customFeeds = CONFIG.rssFeeds.custom as Record<string, string>;
        if (customFeeds[name]) {
          delete customFeeds[name];
          saveConfig(CONFIG);

          return {
            content: [
              {
                type: 'text' as const,
                text: `RSS feed '${name}' has been removed.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: `RSS feed '${name}' not found.`,
              },
            ],
          };
        }
      } catch (error) {
        return handleToolError(error, 'Error removing RSS feed');
      }
    }
  );

  const transport = new StdioServerTransport();
  console.error('Nostr MCP server starting...');
  await server.connect(transport);
  console.error('Nostr MCP server started. Waiting for requests...');
}

startServer().catch((error) => {
  console.error('Error starting server:', error);
  process.exit(1);
});
