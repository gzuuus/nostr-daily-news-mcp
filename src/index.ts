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

/**
 * Load configuration from file, falling back to example or default config if necessary
 */
function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
    }

    if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      console.error('Config file not found. Creating from example...');
      const exampleConfig = JSON.parse(
        fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8')
      ) as Config;
      saveConfig(exampleConfig);
      return exampleConfig;
    }

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

/**
 * Save configuration to file
 */
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

/**
 * Fetch Nostr events from specified relays with given filter
 */
async function fetchEvents(
  relays: string[],
  filter: Filter = { limit: DEFAULT_LIMIT }
): Promise<NostrEvent[]> {
  filter.limit = filter.limit || DEFAULT_LIMIT;

  try {
    const events = await pool.querySync(relays, filter);
    return events.sort((a, b) => b.created_at - a.created_at);
  } catch (error) {
    console.error(
      `Error fetching events from relays [${relays.join(', ')}]:`,
      error
    );
    throw error;
  }
}

/**
 * Fetch trending notes from configured relays
 */
async function fetchTrendingNotes(
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  return fetchEvents(CONFIG.relays.trending, { limit });
}

/**
 * Fetch news notes from configured relays
 */
async function fetchNewsNotes(
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  return fetchEvents(CONFIG.relays.news, { limit });
}

/**
 * Fetch notes from a named relay group in the configuration
 */
async function fetchCustomRelayNotes(
  relayName: string,
  limit: number = DEFAULT_LIMIT
): Promise<NostrEvent[]> {
  if (relayName === 'trending') {
    return fetchTrendingNotes(limit);
  } else if (relayName === 'news') {
    return fetchNewsNotes(limit);
  }

  if (CONFIG.relays[relayName]) {
    return fetchEvents(CONFIG.relays[relayName], { limit });
  }

  throw new Error(`Relay group '${relayName}' not found in configuration`);
}

interface FormattedItem {
  date: string;
  title?: string;
  author: string;
  content: string;
  link?: string;
  metadata?: Record<string, string>;
}

/**
 * Convert various timestamp formats to ISO string
 */
function formatDate(timestamp: number | string | Date): string {
  const date =
    typeof timestamp === 'number'
      ? new Date(timestamp * 1000)
      : new Date(timestamp);
  return date.toISOString();
}

/**
 * Convert a Nostr event to our standard formatted item structure
 */
function nostrEventToFormattedItem(event: NostrEvent): FormattedItem {
  return {
    date: formatDate(event.created_at),
    author: event.pubkey ? `${event.pubkey.substring(0, 8)}...` : '',
    content: event.content,
    metadata:
      event.kind !== undefined ? { kind: String(event.kind) } : undefined,
  };
}

/**
 * Convert an RSS item to our standard formatted item structure
 */
function rssItemToFormattedItem(item: Parser.Item): FormattedItem {
  try {
    return {
      date: getItemDate(item),
      title: item.title || '',
      author: extractAuthor(item),
      content: item.contentSnippet || item.content || '',
      link: item.link || '',
      metadata: getItemMetadata(item),
    };
  } catch (error) {
    console.error('Error formatting RSS item:', error);
    return {
      date: 'Unknown date',
      title: item.title || 'Unknown title',
      author: 'Unknown',
      content: 'Error processing content',
      link: item.link || '',
    };
  }
}

/**
 * Get the date from an RSS item, with fallbacks
 */
function getItemDate(item: Parser.Item): string {
  if (item.pubDate) return formatDate(item.pubDate);
  if (item.isoDate) return formatDate(item.isoDate);
  return 'Unknown date';
}

/**
 * Get metadata from an RSS item
 */
function getItemMetadata(
  item: Parser.Item
): Record<string, string> | undefined {
  const categories = processCategories(item.categories);
  return categories ? { categories } : undefined;
}

/**
 * Extract author information from an RSS item
 */
function extractAuthor(item: Parser.Item): string {
  try {
    if (item.creator) return item.creator;
    const itemAny = item as any;
    if (itemAny.dcCreator) return itemAny.dcCreator;
    if (itemAny['dc:creator']) return itemAny['dc:creator'];

    const categories = item.categories;
    if (categories && Array.isArray(categories) && categories.length > 0) {
      const firstCategory = categories[0];
      if (
        typeof firstCategory === 'object' &&
        firstCategory !== null &&
        '_' in firstCategory
      ) {
        const categoryValue = (firstCategory as any)._;
        if (typeof categoryValue === 'string') {
          return categoryValue;
        }
      }
    }

    return 'Unknown';
  } catch (error) {
    console.error('Error extracting author:', error);
    return 'Unknown';
  }
}

/**
 * Process categories from an RSS item into a string
 */
function processCategories(categories: any): string | undefined {
  try {
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return undefined;
    }

    return categories
      .map((cat: any) => {
        if (typeof cat === 'string') {
          return cat;
        }

        if (typeof cat === 'object' && cat !== null) {
          if ('_' in cat) {
            const categoryValue = (cat as any)._;
            if (typeof categoryValue === 'string') {
              return categoryValue;
            }
          }

          try {
            return JSON.stringify(cat);
          } catch {
            return 'Unknown category';
          }
        }

        return String(cat);
      })
      .join(', ');
  } catch (error) {
    console.error('Error processing categories:', error);
    return undefined;
  }
}

/**
 * Format an item for display with consistent formatting
 */
function formatItem(item: FormattedItem): string {
  const parts = [`[${item.date}]${item.title ? ` ${item.title}` : ''}`];

  if (item.author) {
    parts.push(`Author: ${item.author}`);
  }

  if (item.metadata) {
    for (const [key, value] of Object.entries(item.metadata)) {
      if (value) {
        const formattedKey = key.charAt(0).toUpperCase() + key.slice(1);
        parts.push(`${formattedKey}: ${value}`);
      }
    }
  }

  if (item.content) {
    parts.push(item.content);
  }

  if (item.link) {
    parts.push(item.link);
  }

  return parts.join('\n');
}

function formatNostrEvent(event: NostrEvent): string {
  return formatItem(nostrEventToFormattedItem(event));
}

/**
 * Fetch and parse an RSS feed from a URL
 */
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

/**
 * Fetch items from Stacker News RSS feed
 */
async function fetchStackerNews(
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  return fetchRssFeed(CONFIG.rssFeeds.stackerNews as string, limit);
}

/**
 * Fetch items from Hacker News RSS feed by type
 */
async function fetchHackerNews(
  type: keyof HackerNewsConfig = 'newest',
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  const hackerNews = CONFIG.rssFeeds.hackerNews as HackerNewsConfig;
  const feedUrl = hackerNews[type];
  if (!feedUrl) {
    throw new Error(
      `Hacker News feed type '${type}' not found in configuration`
    );
  }
  return fetchRssFeed(feedUrl, limit);
}

/**
 * Fetch items from a named RSS feed in the configuration
 */
async function fetchCustomRssFeed(
  feedName: string,
  limit: number = DEFAULT_LIMIT
): Promise<Parser.Item[]> {
  if (feedName === 'stackerNews') {
    return fetchStackerNews(limit);
  }

  if (feedName.startsWith('hackerNews.')) {
    const type = feedName.split(
      '.'
    )[1] as keyof typeof CONFIG.rssFeeds.hackerNews;
    return fetchHackerNews(type, limit);
  }

  const customFeeds = CONFIG.rssFeeds.custom as Record<string, string>;
  if (customFeeds[feedName]) {
    return fetchRssFeed(customFeeds[feedName], limit);
  }

  throw new Error(`RSS feed '${feedName}' not found in configuration`);
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

/**
 * Generic tool handler factory that handles fetching data and formatting the response
 * @typeparam T Type of items being fetched and formatted
 */
function createToolHandler<T>(
  fetchFunction: (limit: number, ...args: any[]) => Promise<T[]>,
  formatFunction: (item: T) => string,
  notFoundMessage: string,
  errorPrefix: string
) {
  return async (params: any) => {
    try {
      const { limit, ...otherParams } = params;
      const items = await fetchFunction(limit, ...Object.values(otherParams));

      if (items.length === 0) {
        return {
          content: [{ type: 'text' as const, text: notFoundMessage }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: items.map(formatFunction).join('\n\n'),
          },
        ],
      };
    } catch (error) {
      return handleToolError(error, errorPrefix);
    }
  };
}

/**
 * Creates a handler for Nostr event tools
 */
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

/**
 * Creates a handler for RSS feed tools
 */
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

  /**
   * Custom fetch events tool handler that builds a filter from parameters
   */
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
        // Build filter from parameters
        const filter: Filter = { limit };
        if (kinds) filter.kinds = kinds;
        if (authors) filter.authors = authors;
        if (since) filter.since = since;
        if (until) filter.until = until;

        // Fetch and format events
        const events = await fetchEvents(relays, filter);

        if (events.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No events found for the specified filter.',
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

  /**
   * Fetch from a configured relay group
   */
  server.tool(
    'fetch-relay-group',
    'Fetch notes from a configured relay group',
    {
      relayGroup: z.string(),
      limit: z.number().optional().default(DEFAULT_LIMIT),
    },
    createToolHandler<NostrEvent>(
      // Adapter function that matches the expected signature
      (limit, relayGroup) => fetchCustomRelayNotes(relayGroup, limit),
      formatNostrEvent,
      'No events found for the specified relay group.',
      'Error fetching events from relay group'
    )
  );

  server.tool(
    'fetch-stacker-news',
    'Fetch latest news and discussions from Stacker News RSS feed',
    notesSchema,
    createRssToolHandler(fetchStackerNews, 'No Stacker News items found.')
  );

  /**
   * Fetch from Hacker News RSS feed by type
   */
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
    createToolHandler<Parser.Item>(
      (limit, type) => fetchHackerNews(type, limit),
      formatRssItem,
      'No Hacker News items found.',
      'Error fetching Hacker News RSS feed'
    )
  );

  /**
   * Fetch from a custom RSS feed by name
   */
  server.tool(
    'fetch-custom-rss',
    'Fetch news from a custom RSS feed',
    {
      feedName: z.string(),
      limit: z.number().optional().default(DEFAULT_LIMIT),
    },
    createToolHandler<Parser.Item>(
      (limit, feedName) => fetchCustomRssFeed(feedName, limit),
      formatRssItem,
      'No items found for the specified RSS feed.',
      'Error fetching custom RSS feed'
    )
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
