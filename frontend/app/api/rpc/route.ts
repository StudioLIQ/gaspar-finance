// Casper RPC Proxy
//
// Proxies JSON-RPC requests to Casper node to avoid CORS issues.
// This route handles preflight (OPTIONS) and POST requests.

import { NextRequest, NextResponse } from 'next/server';

// Get RPC URL from environment or default
function getRpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CASPER_NODE_ADDRESS ||
    process.env.NEXT_PUBLIC_CASPER_RPC_URL ||
    'https://node.testnet.casper.network/rpc'
  );
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
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return NextResponse.json(data, {
      status: response.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
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
        },
      }
    );
  }
}
