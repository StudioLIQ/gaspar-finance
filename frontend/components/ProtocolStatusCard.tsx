'use client';

import { Card } from '@/components/ui/Card';
import {
  CONTRACTS,
  isContractsDeployed,
  isLSTDeployed,
  getNetworkConfig,
  formatContractHash,
  PROTOCOL_PARAMS
} from '@/lib/config';

export function ProtocolStatusCard() {
  const network = getNetworkConfig();
  const deployed = isContractsDeployed();
  const lstDeployed = isLSTDeployed();

  return (
    <Card title="Protocol Status" subtitle={`${network.name} integration`}>
      <div className="space-y-4 text-sm">
        {/* Deployment Status */}
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${deployed ? 'bg-green-500' : 'bg-yellow-500'}`} />
          <span className="text-gray-600">
            {deployed ? 'Contracts deployed' : 'Awaiting deployment'}
          </span>
        </div>

        {/* Contract Addresses */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Core Contracts
          </div>
          <div className="grid gap-1.5 text-xs">
            <ContractRow name="Router" hash={CONTRACTS.router} />
            <ContractRow name="Registry" hash={CONTRACTS.registry} />
            <ContractRow name="Stablecoin" hash={CONTRACTS.stablecoin} />
            <ContractRow name="Oracle" hash={CONTRACTS.oracleAdapter} />
          </div>
        </div>

        {/* LST Contracts */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              LST (stCSPR)
            </div>
            <span className={`text-xs ${lstDeployed ? 'text-green-600' : 'text-gray-400'}`}>
              {lstDeployed ? 'Deployed' : 'Not deployed'}
            </span>
          </div>
          <div className="grid gap-1.5 text-xs">
            <ContractRow name="stCSPR ybToken" hash={CONTRACTS.scsprYbtoken} />
            <ContractRow name="Withdraw Queue" hash={CONTRACTS.withdrawQueue} />
          </div>
        </div>

        {/* Branch Contracts */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Collateral Branches
          </div>
          <div className="grid gap-1.5 text-xs">
            <ContractRow name="CSPR Branch" hash={CONTRACTS.branchCspr} />
            <ContractRow name="stCSPR Branch" hash={CONTRACTS.branchSCSPR} />
          </div>
        </div>

        {/* Protocol Parameters */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Protocol Parameters
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <ParamRow label="MCR" value={`${PROTOCOL_PARAMS.MCR_BPS / 100}%`} />
            <ParamRow label="CCR" value={`${PROTOCOL_PARAMS.CCR_BPS / 100}%`} />
            <ParamRow label="Liq. Penalty" value={`${PROTOCOL_PARAMS.LIQUIDATION_PENALTY_BPS / 100}%`} />
            <ParamRow label="Redemption Fee" value={`${PROTOCOL_PARAMS.REDEMPTION_BASE_FEE_BPS / 100}%`} />
          </div>
        </div>

        {!deployed && (
          <div className="rounded-lg border border-dashed border-yellow-200 bg-yellow-50 p-3 text-yellow-700">
            <div className="font-medium">Deployment Required</div>
            <div className="text-xs mt-1">
              Run <code className="bg-yellow-100 px-1 rounded">casper/scripts/deploy.sh</code> to deploy contracts
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ContractRow({ name, hash }: { name: string; hash: string | null }) {
  const isDeployed = hash !== null && hash !== 'null';

  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-600">{name}</span>
      <span className={`font-mono ${isDeployed ? 'text-gray-900' : 'text-gray-400'}`}>
        {formatContractHash(hash)}
      </span>
    </div>
  );
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center bg-gray-50 rounded px-2 py-1">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  );
}
