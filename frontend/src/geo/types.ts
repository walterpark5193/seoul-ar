export interface GuShape { name: string; code: string; centroid: [number, number]; rings: [number, number][][]; }
export interface Geo { v: 1; crs: "unit-square" | "tile"; gus: GuShape[]; }
