import type { Address } from "viem";
import anvil from "./31337.json" with { type: "json" };

export interface ContractDeployment {
  address: Address;
  startBlock: number;
}

export interface Deployment {
  Land: ContractDeployment;
  PlayerRegistry: ContractDeployment;
}

// Written by contracts/script/Deploy.s.sol. Add a line here after deploying to Base Sepolia (84532).
const deployments: Record<number, Deployment> = {
  31337: anvil as Deployment,
};

export function deploymentFor(chainId: number): Deployment {
  const deployment = deployments[chainId];
  if (!deployment) throw new Error(`no deployment for chain ${chainId}`);
  return deployment;
}
