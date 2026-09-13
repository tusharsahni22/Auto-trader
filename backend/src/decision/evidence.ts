import { CLUSTER_WEIGHTS, type Claim, type Cluster, type DroppedClaim, type EvidenceGraph } from "./types.js";
import { verifyClaim } from "./claims.js";

const LAMBDA = 0.3; // docs/01 §4.3 — sibling claims in a cluster count at 30%.

export function buildEvidenceGraph(claims: Claim[]): EvidenceGraph {
  const admitted: Claim[] = [];
  const dropped: DroppedClaim[] = [];

  for (const c of claims) {
    if (verifyClaim(c)) admitted.push(c);
    else dropped.push({ claim: c, reason: "CITATION_MISMATCH" });
  }

  const byCluster = new Map<Cluster, Claim[]>();
  for (const c of admitted) {
    if (!byCluster.has(c.cluster)) byCluster.set(c.cluster, []);
    byCluster.get(c.cluster)!.push(c);
  }

  const clusters = [...byCluster.entries()].map(([cluster, claimsInCluster]) => {
    const sorted = [...claimsInCluster].sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
    const top = sorted[0];
    const rest = sorted.slice(1);
    const effectiveStrength =
      Math.sign(top.strength) * (Math.abs(top.strength) + LAMBDA * rest.reduce((s, c) => s + Math.abs(c.strength), 0));
    return {
      cluster,
      effectiveStrength,
      claimCount: claimsInCluster.length,
      weight: CLUSTER_WEIGHTS[cluster],
      logOddsContribution: 0, // filled in by the ensemble step, which owns kappa/reliability
    };
  });

  const totalAbs = clusters.reduce((s, c) => s + Math.abs(c.effectiveStrength) * c.weight, 0);
  const minorityAbs = clusters
    .filter((c) => Math.sign(c.effectiveStrength) !== majoritySign(clusters))
    .reduce((s, c) => s + Math.abs(c.effectiveStrength) * c.weight, 0);
  const conflict = totalAbs > 0 ? minorityAbs / totalAbs : 0;

  // docs/01 §5.2 — N_eff via cluster count as a stand-in for the Ledoit-Wolf
  // shrunk correlation estimate, which needs ~250 historical snapshots this
  // MVP has not accumulated yet. A flat redundancy discount (0.7 per extra
  // correlated cluster) approximates the same qualitative behaviour: adding
  // clusters helps, but with diminishing returns, never linearly.
  const n = clusters.length;
  const nEffectiveSignals = n === 0 ? 0 : 1 + (n - 1) * 0.55;

  return { admitted, dropped, clusters, nEffectiveSignals, conflict };
}

function majoritySign(clusters: { effectiveStrength: number; weight: number }[]): number {
  const net = clusters.reduce((s, c) => s + c.effectiveStrength * c.weight, 0);
  return Math.sign(net) || 1;
}
