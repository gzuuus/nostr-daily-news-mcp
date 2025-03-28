# Nostr Daily News MCP Server

A Model Context Protocol (MCP) server that interacts with Nostr relays and RSS feeds to fetch trending notes, news, and discussions.

## Features

- Uses the official MCP TypeScript SDK
- Fetch trending notes from `wss://algo.utxo.one`
- Fetch news from `wss://news.utxo.one`
- Fetch RSS feeds from Stacker News
- Flexible custom queries to any Nostr relay
- DRY (Don't Repeat Yourself) code architecture
- Configurable limit for the number of notes to retrieve

## Installation

```bash
bun install
```

## Usage

```bash
bun start
```

## Testing

To test the MCP server, run:

```bash
bun run src/test.ts
```

## MCP Tools

This server implements the following MCP tools:

### fetch-trending-notes

Fetches trending notes from algo.utxo.one.

```typescript
// Example client usage
const result = await client.callTool({
  name: "fetch-trending-notes",
  arguments: { limit: 10 },
});
```

### fetch-news-notes

Fetches news notes from news.utxo.one.

```typescript
// Example client usage
const result = await client.callTool({
  name: "fetch-news-notes",
  arguments: { limit: 5 },
});
```

### fetch-stacker-news

Fetches latest news and discussions from Stacker News RSS feed.

```typescript
// Example client usage
const result = await client.callTool({
  name: "fetch-stacker-news",
  arguments: { limit: 10 },
});
```

### fetch-custom-events

Fetches Nostr events with custom filters from specified relay URLs.

```typescript
// Example client usage
const result = await client.callTool({
  name: "fetch-custom-events",
  arguments: {
    relays: ["wss://relay.damus.io", "wss://relay.snort.social"],
    limit: 5,
    kinds: [1],
    authors: ["pubkey1", "pubkey2"],
    since: 1648771200,
    until: 1680307200,
  },
});
```

## Development

This project was created using:

- Bun - JavaScript runtime and package manager
- TypeScript - Type-safe JavaScript
- nostr-tools - Library for interacting with Nostr relays
- @modelcontextprotocol/sdk - Official MCP TypeScript SDK

## Project Structure

- `src/index.ts` - Main MCP server implementation
- `src/test.ts` - Test script to verify the server functionality
