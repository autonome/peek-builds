export declare const DECAY_HALF_LIFE_DAYS: number;
export declare const VISIT_WEIGHTS: {
  interacted: number;
  direct: number;
  default: number;
};

export declare function calculateItemFrecency(
  visits: Array<{ timestamp: number; interacted: number; source: string }>
): number;

export default calculateItemFrecency;
