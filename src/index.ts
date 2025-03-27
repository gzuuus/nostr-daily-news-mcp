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
  stackerNews: 'https://stacker.news/rss'
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

function formatNostrEvent(event: NostrEvent): string {
  const date = new Date(event.created_at * 1000).toISOString();
  return `[${date}] ${event.content}`;
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

function formatRssItem(item: Parser.Item): string {
  const date = item.pubDate ? new Date(item.pubDate).toISOString() : 'Unknown date';
  const title = item.title || 'No title';
  const link = item.link || '';
  
  return `[${date}] ${title}\n${link}`;
}

function createNotesToolHandler(
  fetchFunction: (limit: number) => Promise<NostrEvent[]>,
  notFoundMessage: string
) {
  return async ({ limit }: { limit: number }, extra: any) => {
    try {
      const notes = await fetchFunction(limit);
      return {
        content: [{ 
          type: "text" as const, 
          text: notes.length > 0 
            ? notes.map(formatNostrEvent).join('\n\n') 
            : notFoundMessage
        }]
      };
    } catch (error) {
      return {
        content: [{ 
          type: "text" as const, 
          text: `Error fetching notes: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  };
}

function createRssToolHandler(
  fetchFunction: (limit: number) => Promise<Parser.Item[]>,
  notFoundMessage: string
) {
  return async ({ limit }: { limit: number }, extra: any) => {
    try {
      const items = await fetchFunction(limit);
      return {
        content: [{ 
          type: "text" as const, 
          text: items.length > 0 
            ? items.map(formatRssItem).join('\n\n') 
            : notFoundMessage
        }]
      };
    } catch (error) {
      return {
        content: [{ 
          type: "text" as const, 
          text: `Error fetching RSS feed: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  };
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
    async ({ relays, limit, kinds, authors, since, until }, extra: any) => {
      try {
        const filter: Filter = { limit };
        if (kinds) filter.kinds = kinds;
        if (authors) filter.authors = authors;
        if (since) filter.since = since;
        if (until) filter.until = until;
        
        const events = await fetchEvents(relays, filter);
        return {
          content: [{ 
            type: "text" as const, 
            text: events.length > 0 
              ? events.map(formatNostrEvent).join('\n\n') 
              : `No events found for the specified filter.`
          }]
        };
      } catch (error) {
        return {
          content: [{ 
            type: "text" as const, 
            text: `Error fetching events: ${error instanceof Error ? error.message : String(error)}`
          }]
        };
      }
    }
  );

  server.tool(
    "fetch-stacker-news",
    "Fetch latest news and discussions from Stacker News RSS feed",
    notesSchema,
    createRssToolHandler(fetchStackerNews, "No Stacker News items found.")
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
