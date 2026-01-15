// Casper RPC Proxy
//
// Proxies JSON-RPC requests to Casper node to avoid CORS issues.
// This route handles preflight (OPTIONS) and POST requests.

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

let cachedRpcUrl: string | null = null;

function readRpcUrlFromConfig(): string | null {
  const network = process.env.NEXT_PUBLIC_CASPER_NETWORK || 'testnet';
  const candidates = [
    path.join(process.cwd(), 'config', `casper-${network}.json`),
    path.join(process.cwd(), 'public', 'config', `casper-${network}.json`),
    path.join(process.cwd(), 'frontend', 'config', `casper-${network}.json`),
    path.join(process.cwd(), 'frontend', 'public', 'config', `casper-${network}.json`),
  ];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { nodeAddress?: string };
      if (parsed?.nodeAddress) return parsed.nodeAddress;
    } catch {
      continue;
    }
  }

  return null;
}

// Get RPC URL from environment or default
function getRpcUrl(): string {
  if (cachedRpcUrl) return cachedRpcUrl;

  const envUrl =
    process.env.NEXT_PUBLIC_CASPER_NODE_ADDRESS ||
    process.env.NEXT_PUBLIC_CASPER_RPC_URL;
  if (envUrl) {
    cachedRpcUrl = envUrl;
    return envUrl;
  }

  const configUrl = readRpcUrlFromConfig();
  if (configUrl) {
    cachedRpcUrl = configUrl;
    return configUrl;
  }

  cachedRpcUrl = 'https://node.testnet.casper.network/rpc';
  return cachedRpcUrl;
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// Proxy RPC requests
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rpcUrl = getRpcUrl();

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return NextResponse.json(data, {
      status: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  } catch (error) {
    console.error('[RPC Proxy] Error:', error);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'Internal proxy error',
          data: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  }
}
