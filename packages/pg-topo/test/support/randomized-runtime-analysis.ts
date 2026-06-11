import { analyzeAndSort } from "../../src/analyze-and-sort";
import type { AnalyzeResult } from "../../src/model/types";
import { collectStatementsFromRoots } from "./randomized-input";
import { shuffleDeterministic } from "./shuffle";

type RandomizedRuntimeAnalyzeOptions = {
  roots: string[];
  seed: number;
};

export const analyzeAndSortFromRandomizedStatements = async (
  options: RandomizedRuntimeAnalyzeOptions,
): Promise<AnalyzeResult> => {
  const { roots, seed } = options;
  const statements = await collectStatementsFromRoots(roots);
  const shuffled = shuffleDeterministic(statements, seed);

  return await analyzeAndSort(shuffled);
};
