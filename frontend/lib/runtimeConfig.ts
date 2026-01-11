import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from './config';

const readJsonFile = (filePath: string): RuntimeConfig | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as RuntimeConfig;
  } catch {
    return null;
  }
};

const buildCandidatePaths = (network: string) => {
  const bases = [
    process.cwd(),
    path.join(process.cwd(), 'frontend'),
    path.join(process.cwd(), '..'),
  ];

  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(path.join(base, 'config', `casper-${network}.json`));
    candidates.push(path.join(base, 'public', 'config', `casper-${network}.json`));
  }

  return candidates;
};

export const loadRuntimeConfig = (): RuntimeConfig | null => {
  const network = process.env.NEXT_PUBLIC_CASPER_NETWORK || 'testnet';
  const candidates = buildCandidatePaths(network);

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const parsed = readJsonFile(filePath);
    if (parsed) return parsed;
  }

  return null;
};
