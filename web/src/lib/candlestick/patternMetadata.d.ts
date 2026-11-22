export interface PatternMeta {
  type: 'reversal' | 'continuation' | 'neutral';
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  strength: 'weak' | 'moderate' | 'strong';
  description: string;
}

export const patternMetadata: Record<string, PatternMeta>;
export function getPatternMetadata(name: string): PatternMeta | undefined;
