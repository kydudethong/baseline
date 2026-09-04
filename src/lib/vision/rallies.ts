/**
 * Rally boundaries from paddle-contact timestamps. One implementation,
 * used by both the coaching facts (facts.ts) and the vision pipeline (to
 * decide which windows of the clip are worth running the ball detector
 * over) — so the rallies the coach talks about and the rallies the ball
 * was tracked in are the same rallies.
 *
 * Gap-based grouping: contacts closer than gapS belong to the same rally;
 * a group needs minShots contacts and minDurationS of play to count.
 * Ported from Baseline's original segment.ts clusterRallies().
 */

export interface ClusterParams {
  gapS: number;
  minShots: number;
  minDurationS: number;
  leadS: number;
  tailS: number;
}

export const CLUSTER_PARAMS: ClusterParams = {
  gapS: 3.5,
  minShots: 4,
  minDurationS: 1.5,
  leadS: 0.5,
  tailS: 0.8,
};

export interface ClusteredRally {
  idx: number;
  startS: number;
  endS: number;
  contacts: number[];
}

export function clusterRalliesWithContacts(onsets: number[], params: ClusterParams = CLUSTER_PARAMS): ClusteredRally[] {
  if (onsets.length === 0) return [];
  const sorted = [...onsets].sort((a, b) => a - b);

  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const group = groups[groups.length - 1];
    if (sorted[i] - group[group.length - 1] > params.gapS) groups.push([sorted[i]]);
    else group.push(sorted[i]);
  }

  const rallies: ClusteredRally[] = [];
  for (const group of groups) {
    if (group.length < params.minShots) continue;
    const startS = Math.max(0, group[0] - params.leadS);
    const endS = group[group.length - 1] + params.tailS;
    if (endS - startS < params.minDurationS) continue;
    rallies.push({ idx: rallies.length + 1, startS, endS, contacts: group });
  }
  return rallies;
}
