import { InternalConsistencyError } from "../errors";
import type { AssociationTable } from "../types";
import { runUnpaced } from "../utils/eventLoop";
import {
  groupDistinctByKey,
  indexInSorted,
  sortedDistinct,
} from "./int32Groups";

/**
 * One entity cluster of an association table: a connected component of the
 * bipartite graph whose vertices are the two parties' matched records and whose
 * edges are the table's pairs.
 *
 * Both halves are this cluster's members in their own party's row space, ascending
 * and distinct. A cluster always holds at least one record of each party, every
 * vertex reaching the graph through a pair (docs/spec/PROTOCOL.md, The
 * `many-to-many` entity closure).
 */
interface EntityCluster {
  readonly localRows: ReadonlyArray<number>;
  readonly partnerRows: ReadonlyArray<number>;
}

// A table's entity clusters, every record and pair held in typed arrays: a
// `Map` or `Set` holds at most 2^24 entries (docs/spec/PROTOCOL.md, One
// round's matched records). Each party's distinct rows are numbered in
// ascending order, and cluster `c` holds the local rows `localRows[k]` with
// `clusterOfLocal[k] === c` and the partner rows likewise. Clusters are
// numbered in the order of their lowest local row.
interface ClusterIndex {
  readonly localRows: Float64Array;
  readonly partnerRows: Float64Array;
  readonly clusterOfLocal: Int32Array;
  readonly clusterOfPartner: Int32Array;
  readonly clusterCount: number;
}

function assertSameLength(table: AssociationTable): void {
  if (table[0].length !== table[1].length)
    throw new InternalConsistencyError(
      "the association table's halves have different lengths: " +
        `${table[0].length} vs ${table[1].length}. Each entry is one ` +
        "matched pair, so the two halves are read together.",
    );
}

function find(parent: Int32Array, node: number): number {
  let root = node;
  while (parent[root] !== root) root = parent[root];
  let walk = node;
  while (parent[walk] !== root) {
    const next = parent[walk];
    parent[walk] = root;
    walk = next;
  }
  return root;
}

// The connected components of the bipartite graph over the two row spaces: a
// local row and a partner row are separate vertices, so a row index shared by
// the two parties is two vertices rather than one.
function clusterIndex(table: AssociationTable): ClusterIndex {
  const localRows = sortedDistinct(table[0]);
  const partnerRows = sortedDistinct(table[1]);
  const localCount = localRows.length;
  const parent = new Int32Array(localCount + partnerRows.length);
  for (let node = 0; node < parent.length; ++node) parent[node] = node;
  for (let i = 0; i < table[0].length; ++i) {
    const a = find(parent, indexInSorted(localRows, table[0][i]));
    const b = find(
      parent,
      localCount + indexInSorted(partnerRows, table[1][i]),
    );
    if (a !== b) parent[a] = b;
  }
  const clusterOfRoot = new Int32Array(parent.length).fill(-1);
  const clusterOfLocal = new Int32Array(localCount);
  let clusterCount = 0;
  for (let k = 0; k < localCount; ++k) {
    const root = find(parent, k);
    if (clusterOfRoot[root] < 0) clusterOfRoot[root] = clusterCount++;
    clusterOfLocal[k] = clusterOfRoot[root];
  }
  const clusterOfPartner = new Int32Array(partnerRows.length);
  for (let k = 0; k < partnerRows.length; ++k)
    clusterOfPartner[k] = clusterOfRoot[find(parent, localCount + k)];
  return {
    localRows,
    partnerRows,
    clusterOfLocal,
    clusterOfPartner,
    clusterCount,
  };
}

// How many of `clusterOf`'s rows each cluster holds.
function clusterSizes(clusterOf: Int32Array, clusterCount: number): Int32Array {
  const sizes = new Int32Array(clusterCount);
  for (const cluster of clusterOf) ++sizes[cluster];
  return sizes;
}

// Each cluster's rows, ascending: `rows` ascends, so filling the clusters in
// its order keeps each one's rows in that order. Each array is allocated at
// its final length, the one-row clusters most tables hold costing one slot.
function rowsByCluster(
  rows: Float64Array,
  clusterOf: Int32Array,
  clusterCount: number,
): Array<Array<number>> {
  const sizes = clusterSizes(clusterOf, clusterCount);
  const byCluster = Array.from(
    { length: clusterCount },
    (_, cluster): Array<number> => new Array<number>(sizes[cluster]),
  );
  const filled = new Int32Array(clusterCount);
  for (let k = 0; k < rows.length; ++k) {
    const cluster = clusterOf[k];
    byCluster[cluster][filled[cluster]++] = rows[k];
  }
  return byCluster;
}

/**
 * The entity clusters of an association table: the closure step a party runs
 * LOCALLY, over the table it already holds, with no additional exchange
 * (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * Both output-entitled parties end the cascade holding the same table, so both
 * compute the same clusters from it -- the agreement is a property of that one
 * table rather than of a further reconciliation, and nothing here reads a round, a
 * linkage-key value, or any quantity the partner declares.
 *
 * Clusters are ordered by their lowest local row, and each cluster's two halves
 * ascend, whatever order the table's pairs arrive in, so one table has one
 * arrangement: a party recomputing, or two readers of that same party's table, get
 * the same list. Each party orders by its OWN lowest row over a table transposed
 * from its partner's, so what the two parties hold in common is the cluster SET,
 * each cluster's halves ascending, rather than the order the clusters are listed
 * in.
 *
 * @param table - A matched table read as pairs: entry `i` pairs `table[0][i]`
 *   with `table[1][i]`. A repeated pair would be one edge counted twice, which
 *   changes no component; `assertMatchedPairsWellFormed` (exchange.ts) refuses
 *   one.
 */
export function entityClusters(table: AssociationTable): Array<EntityCluster> {
  assertSameLength(table);
  const index = clusterIndex(table);
  const local = rowsByCluster(
    index.localRows,
    index.clusterOfLocal,
    index.clusterCount,
  );
  const partner = rowsByCluster(
    index.partnerRows,
    index.clusterOfPartner,
    index.clusterCount,
  );
  return local.map((localRows, cluster) => ({
    localRows,
    partnerRows: partner[cluster],
  }));
}

/**
 * One block of a both-sided round: the records of each party that contributed
 * one matched value, in their own party's row space. Every pair between them is
 * accepted, `many-to-many` acceptance being total, so a block is the whole
 * `m x n` product (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * A record contributing several of a round's matched values stands in several
 * of that round's blocks, which is what joins them into one cluster.
 */
export interface ClosureBlock {
  readonly localRows: ReadonlyArray<number>;
  readonly partnerRows: ReadonlyArray<number>;
}

/**
 * One shape a run's entity clusters take: how many records of each party a
 * cluster of that shape holds, how many distinct matched values formed it, and
 * how many of the run's clusters share all three figures.
 *
 * A block is one matched value, so `distinctValues` is the blocks a cluster's
 * records stand in: one for a single block, more for a chain
 * (docs/spec/PROTOCOL.md, Choosing linkage keys under closure).
 */
export interface EntityClusterShape {
  readonly localRows: number;
  readonly partnerRows: number;
  readonly distinctValues: number;
  readonly clusters: number;
}

/**
 * The cluster diagnostic a party reads off its own `many-to-many` result: how
 * many entity clusters the run produced, how many records of each party they
 * hold between them, and the distribution of their shapes, largest first
 * (docs/spec/PROTOCOL.md, Choosing linkage keys under closure).
 *
 * Every figure is a count over this party's own table and the round's own
 * blocks, so the summary names no record, no row index, and no linkage-key
 * value, and holds nothing the partner sent beyond the pairs the result file
 * already states.
 */
export interface EntityClusterSummary {
  /** How many clusters the table's pairs fall into. */
  readonly clusterCount: number;
  /** How many of this party's records stand in a cluster. */
  readonly localRows: number;
  /** How many of the partner's records stand in a cluster. */
  readonly partnerRows: number;
  /**
   * Every shape the clusters take, largest first by the records a cluster
   * holds, then by this party's half, then the partner's, then the values.
   * Clusters are merged into one entry only where all three of their figures
   * agree, so a shape's per-cluster value count is exact.
   */
  readonly shapes: ReadonlyArray<EntityClusterShape>;
}

/**
 * Requires a matched table's entity clusters to be round-diagonal: a cluster may
 * span several blocks of one round and never two rounds
 * (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * Four conditions hold the shape, and this refuses each -- a cluster whose
 * pairs were matched in two different rounds, a block split across two clusters,
 * a block the table does not hold every pair of, and a pair of the table no
 * block names. The last two are the two containments between the table's pairs
 * and the blocks' union, so a cluster holds the pairs its blocks name and no
 * others. What they secure is that every grouping the closure hands the operator
 * rests on the round's own matched values: a cluster's records are joined by the
 * values its blocks were built from, and by nothing the partner's returned list
 * decided on its own.
 *
 * The blocks are the round's own, read per matched VALUE rather than per record,
 * so a record standing in two of a round's blocks -- which is what a candidate
 * set produces -- is held to both rather than having them flattened into one
 * grouping this could not see past.
 *
 * The returned-list check (`resolveRunGroupedReturn`, utils/partnerIndices.ts)
 * runs ahead of this one and holds the partner's runs to the pairing this party
 * resolved, within a round and across them: each round's rows fall into the
 * sets of this party's records the round accepted together, and no row is named
 * in two rounds. What it does not read is this party's own round state agreeing
 * with the table built from its result -- the round label on each pair and the
 * round's blocks come from that state rather than from the list. That is why a
 * violation here is an internal inconsistency rather than a partner fault, and
 * why the claim is pinned on the artifact every consumer reads rather than left
 * to rest on that argument alone.
 *
 * @param id - The participant id the message is attributed to.
 * @param table - The matched table, read as pairs.
 * @param roundOfPair - The key round each pair of `table` was matched in.
 * @param blocks - Every block the rounds produced, in the two parties' row
 *   spaces.
 * @returns The {@link EntityClusterSummary} over the clusters just checked.
 *   Each block is attributed to the one cluster the conditions above hold it
 *   to, which is what makes a cluster's distinct-value count its block count.
 */
export function assertRoundDiagonalClosure(
  id: string,
  table: AssociationTable,
  roundOfPair: ReadonlyArray<number>,
  blocks: ReadonlyArray<ClosureBlock>,
): EntityClusterSummary {
  if (roundOfPair.length !== table[0].length)
    throw new InternalConsistencyError(
      `${id}: the closure check was given ${roundOfPair.length} round ` +
        `label(s) for ${table[0].length} matched pair(s)`,
    );

  assertSameLength(table);
  const index = clusterIndex(table);
  const { localRows, partnerRows, clusterOfLocal, clusterOfPartner } = index;
  const pairCount = table[0].length;
  const localOfPair = new Int32Array(pairCount);
  const partnerOfPair = new Int32Array(pairCount);
  for (let i = 0; i < pairCount; ++i) {
    localOfPair[i] = indexInSorted(localRows, table[0][i]);
    partnerOfPair[i] = indexInSorted(partnerRows, table[1][i]);
  }
  const clusterOfRow =
    (rows: Float64Array, clusterOf: Int32Array) =>
    (row: number): number => {
      const k = indexInSorted(rows, row);
      return k < 0 ? -1 : clusterOf[k];
    };
  const clusterOfLocalRow = clusterOfRow(localRows, clusterOfLocal);
  const clusterOfPartnerRow = clusterOfRow(partnerRows, clusterOfPartner);
  const lowestLocalRow = new Float64Array(index.clusterCount);
  for (let k = localRows.length - 1; k >= 0; --k)
    lowestLocalRow[clusterOfLocal[k]] = localRows[k];

  const roundOfCluster = new Float64Array(index.clusterCount).fill(-1);
  for (let i = 0; i < pairCount; ++i) {
    const cluster = clusterOfLocal[localOfPair[i]];
    const round = roundOfCluster[cluster];
    if (round < 0) roundOfCluster[cluster] = roundOfPair[i];
    else if (round !== roundOfPair[i])
      throw notRoundDiagonal(
        id,
        `the cluster holding this party's record ${lowestLocalRow[cluster]} ` +
          "joins pairs matched on two different linkage keys, where a record " +
          "standing in any of a key's candidate pairs leaves candidacy for " +
          "every later key",
      );
  }

  // The table's pairs grouped by local row, each group's partner rows
  // ascending and distinct, and which of them a block holds.
  const partnersOfLocal = runUnpaced(
    groupDistinctByKey(localOfPair, partnerOfPair, localRows.length),
  );
  const coveredByBlocks = new Uint8Array(partnersOfLocal.values.length);
  const pairPlace = (local: number, partner: number): number => {
    const l = indexInSorted(localRows, local);
    const p = indexInSorted(partnerRows, partner);
    if (l < 0 || p < 0) return -1;
    return indexInSorted(
      partnersOfLocal.values,
      p,
      partnersOfLocal.starts[l],
      partnersOfLocal.starts[l + 1],
    );
  };

  const valuesOfCluster = new Int32Array(index.clusterCount);
  for (const block of blocks) {
    if (block.localRows.length === 0 || block.partnerRows.length === 0)
      throw new InternalConsistencyError(
        `${id}: the closure check was given a block with no record on one ` +
          "side, where a block is the records that contributed one matched value",
      );
    const cluster = clusterOfLocalRow(block.localRows[0]);
    if (cluster < 0)
      throw notRoundDiagonal(
        id,
        `one matched value's block names this party's record ` +
          `${block.localRows[0]}, which the table pairs with none of the ` +
          "partner's",
      );
    ++valuesOfCluster[cluster];
    for (const row of block.localRows)
      if (clusterOfLocalRow(row) !== cluster)
        throw notRoundDiagonal(
          id,
          "one matched value's pairs are split across the clusters holding " +
            `this party's records ${block.localRows[0]} and ${row}`,
        );
    for (const row of block.partnerRows)
      if (clusterOfPartnerRow(row) !== cluster)
        throw notRoundDiagonal(
          id,
          "one matched value's pairs are split across the cluster holding " +
            `this party's record ${block.localRows[0]} and the one holding ` +
            `the partner's record ${row}`,
        );
    for (const local of block.localRows) {
      for (const partner of block.partnerRows) {
        const place = pairPlace(local, partner);
        if (place < 0)
          throw notRoundDiagonal(
            id,
            `the block of one matched value covers ${block.localRows.length} ` +
              `record(s) of this party and ${block.partnerRows.length} of the ` +
              `partner's, and the table holds no pair between this party's ` +
              `record ${local} and the partner's ${partner}, where a block ` +
              "holds every pair between the records that contributed its value",
          );
        coveredByBlocks[place] = 1;
      }
    }
  }

  for (let i = 0; i < pairCount; ++i)
    if (coveredByBlocks[pairPlace(table[0][i], table[1][i])] !== 1)
      throw notRoundDiagonal(
        id,
        `the table pairs this party's record ${table[0][i]} with the ` +
          `partner's ${table[1][i]}, and no matched value's block holds that ` +
          "pair, so the cluster it joins rests on an edge the round did not " +
          "produce",
      );

  return summarizeClusters(
    clusterSizes(clusterOfLocal, index.clusterCount),
    clusterSizes(clusterOfPartner, index.clusterCount),
    valuesOfCluster,
  );
}

// The shape distribution over the checked clusters, keyed on all three of a
// cluster's figures so merging two clusters into one entry never averages a
// value count.
function summarizeClusters(
  localRowsOfCluster: Int32Array,
  partnerRowsOfCluster: Int32Array,
  valuesOfCluster: Int32Array,
): EntityClusterSummary {
  const byShape = new Map<string, EntityClusterShape>();
  let localRows = 0;
  let partnerRows = 0;
  for (let index = 0; index < localRowsOfCluster.length; ++index) {
    localRows += localRowsOfCluster[index];
    partnerRows += partnerRowsOfCluster[index];
    const shape = {
      localRows: localRowsOfCluster[index],
      partnerRows: partnerRowsOfCluster[index],
      distinctValues: valuesOfCluster[index],
    };
    const key = `${shape.localRows},${shape.partnerRows},${shape.distinctValues}`;
    const held = byShape.get(key);
    byShape.set(key, {
      ...shape,
      clusters: (held?.clusters ?? 0) + 1,
    });
  }
  const shapes = [...byShape.values()].sort(
    (a, b) =>
      b.localRows + b.partnerRows - (a.localRows + a.partnerRows) ||
      b.localRows - a.localRows ||
      b.partnerRows - a.partnerRows ||
      b.distinctValues - a.distinctValues,
  );
  return {
    clusterCount: localRowsOfCluster.length,
    localRows,
    partnerRows,
    shapes,
  };
}

function notRoundDiagonal(
  id: string,
  detail: string,
): InternalConsistencyError {
  return Object.assign(
    new InternalConsistencyError(
      `${id}: the matched table's entity clusters are not the shape a ` +
        `both-sided deduplicating cascade produces: ${detail}. The exchange ` +
        "cannot proceed; report it with this message.",
    ),
    { alcoveRecoveryHintEmitted: true },
  );
}
