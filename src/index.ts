import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SimplePool } from 'nostr-tools/pool';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import type { Filter } from "nostr-tools";
import Parser from 'rss-parser';

useWebSocketImplementation(WebSocket);

const pool = new SimplePool();

const DEFAULT_RELAYS = {
  trending: ['wss://algo.utxo.one'],
  news: ['wss://news.utxo.one']
};

const DEFAULT_LIMIT = 10;

const RSS_FEEDS = {
  stackerNews: 'https://stacker.news/rss',
  hackerNews: {
    newest: 'https://hnrss.org/newest',
    frontpage: 'https://hnrss.org/frontpage',
    bestComments: 'https://hnrss.org/bestcomments',
    ask: 'https://hnrss.org/ask',
    show: 'https://hnrss.org/show'
  }
};

const rssParser = new Parser();

async function fetchEvents(relays: string[], filter: Filter = { limit: DEFAULT_LIMIT }): Promise<NostrEvent[]> {
  if (!filter.limit) {
    filter.limit = DEFAULT_LIMIT;
  }
  
  const events = await pool.querySync(relays, filter);
  return events.sort((a, b) => b.created_at - a.created_at);
}

async function fetchTrendingNotes(limit: number = DEFAULT_LIMIT): Promise<NostrEvent[]> {
  return fetchEvents(DEFAULT_RELAYS.trending, { limit });
}

async function fetchNewsNotes(limit: number = DEFAULT_LIMIT): Promise<NostrEvent[]> {
  return fetchEvents(DEFAULT_RELAYS.news, { limit });
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
  const date = typeof timestamp === 'number' 
    ? new Date(timestamp * 1000) 
    : new Date(timestamp);
  return date.toISOString();
}

function nostrEventToFormattedItem(event: NostrEvent): FormattedItem {
  return {
    date: formatDate(event.created_at),
    title: '',  // Nostr events don't have titles
    author: event.pubkey ? `${event.pubkey.substring(0, 8)}...` : '',
    content: event.content,
    metadata: event.kind !== undefined ? { kind: String(event.kind) } : undefined
  };
}

function rssItemToFormattedItem(item: Parser.Item): FormattedItem {
  return {
    date: item.pubDate ? formatDate(item.pubDate) : 'Unknown date',
    title: item.title || '',
    author: item.creator || '',
    content: item.contentSnippet || '',
    link: item.link || '',
    metadata: item.categories?.length ? { categories: item.categories.join(', ') } : undefined
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

async function fetchRssFeed(feedUrl: string, limit: number = DEFAULT_LIMIT): Promise<Parser.Item[]> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return feed.items.slice(0, limit);
  } catch (error) {
    console.error(`Error fetching RSS feed from ${feedUrl}:`, error);
    throw error;
  }
}

async function fetchStackerNews(limit: number = DEFAULT_LIMIT): Promise<Parser.Item[]> {
  return fetchRssFeed(RSS_FEEDS.stackerNews, limit);
}

async function fetchHackerNews(type: keyof typeof RSS_FEEDS.hackerNews = 'newest', limit: number = DEFAULT_LIMIT): Promise<Parser.Item[]> {
  return fetchRssFeed(RSS_FEEDS.hackerNews[type], limit);
}

function formatRssItem(item: Parser.Item): string {
  return formatItem(rssItemToFormattedItem(item));
}

function handleToolError(error: unknown, errorPrefix: string) {
  return {
    content: [{ 
      type: "text" as const, 
      text: `${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`
    }]
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
          content: [{ type: "text" as const, text: notFoundMessage }]
        };
      }
      
      const formattedItems = items.map(formatFunction);
      
      return {
        content: [{ 
          type: "text" as const, 
          text: formattedItems.join('\n\n')
        }]
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
    "Error fetching notes"
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
    "Error fetching RSS feed"
  );
}

async function startServer() {
  const server = new McpServer({
    name: "Nostr Daily News",
    version: "1.0.0"
  });

  const notesSchema = { limit: z.number().optional().default(DEFAULT_LIMIT) };

  server.tool(
    "fetch-trending-notes",
    "Fetch trending notes from nostr",
    notesSchema,
    createNotesToolHandler(fetchTrendingNotes, "No trending notes found.")
  );

  server.tool(
    "fetch-news-notes",
    "Fetch latest news from nostr",
    notesSchema,
    createNotesToolHandler(fetchNewsNotes, "No news notes found.")
  );

  server.tool(
    "fetch-custom-events",
    "Fetch Nostr events with custom filters from specified relay URLs",
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
            content: [{ type: "text" as const, text: `No events found for the specified filter.` }]
          };
        }
        
        return {
          content: [{ 
            type: "text" as const, 
            text: events.map(formatNostrEvent).join('\n\n')
          }]
        };
      } catch (error) {
        return handleToolError(error, "Error fetching events");
      }
    }
  );

  server.tool(
    "fetch-stacker-news",
    "Fetch latest news and discussions from Stacker News RSS feed",
    notesSchema,
    createRssToolHandler(fetchStackerNews, "No Stacker News items found.")
  );

  server.tool(
    "fetch-hacker-news",
    "Fetch latest news and discussions from Hacker News RSS feed",
    { 
      limit: z.number().optional().default(DEFAULT_LIMIT),
      type: z.enum(['newest', 'frontpage', 'bestComments', 'ask', 'show']).optional().default('newest')
    },
    // Use a specialized handler for Hacker News that can handle the type parameter
    async ({ limit, type }, extra: any) => {
      try {
        const items = await fetchHackerNews(type, limit);
        
        if (items.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No Hacker News items found." }]
          };
        }
        
        return {
          content: [{ 
            type: "text" as const, 
            text: items.map(formatRssItem).join('\n\n')
          }]
        };
      } catch (error) {
        return handleToolError(error, "Error fetching Hacker News RSS feed");
      }
    }
  );

  const transport = new StdioServerTransport();
  console.error('Nostr MCP server starting...');
  await server.connect(transport);
  console.error('Nostr MCP server started. Waiting for requests...');
}

startServer().catch(error => {
  console.error('Error starting server:', error);
  process.exit(1);
});
