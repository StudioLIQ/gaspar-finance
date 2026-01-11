import { Card } from '@/components/ui/Card';
import { CASPER_TESTNET } from '@/lib/config';

export function NetworkCard() {
  return (
    <Card title="Network" subtitle="Casper testnet only">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Network</span>
          <span className="text-sm font-medium text-gray-900">{CASPER_TESTNET.name}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-gray-600">RPC</span>
          <span className="text-sm font-medium text-gray-900 break-all text-right">{CASPER_TESTNET.rpcUrl}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-gray-600">Explorer</span>
          <span className="text-sm font-medium text-gray-900 break-all text-right">{CASPER_TESTNET.explorerUrl}</span>
        </div>
      </div>
    </Card>
  );
}
