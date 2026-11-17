export interface Stat { n: number; cancelled: number; medPerM2: number | null; medAmt: number | null; maxAmt: number | null; truncated: boolean; }
export interface DongStat { name: string; n: number; cancelled: number; nApt: number; medPerM2: number | null; medPerM2Apt: number | null; medAmt: number | null; maxAmt: number | null; usage: Record<string, number>; }
export interface GuData { v: 1; month: string; gu: string; generatedAt: string; total: Stat; dongs: DongStat[]; }
export interface DataIndex { v: 1; generatedAt: string; source: string; months: string[]; gus: string[]; summary: Record<string, Record<string, Stat>>; }
export type Metric = "price" | "count";
