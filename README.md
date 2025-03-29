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

## Development

This project was created using:

- Bun - JavaScript runtime and package manager
- TypeScript - Type-safe JavaScript
- nostr-tools - Library for interacting with Nostr relays
- @modelcontextprotocol/sdk - Official MCP TypeScript SDK

## Project Structure

- `src/index.ts` - Main MCP server implementation
