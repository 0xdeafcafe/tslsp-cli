import { readFileSync } from "node:fs";
import { add, double } from "./math";

const _unused = readFileSync;

export function compute(x: number): number {
  return double(add(x, 1));
}
