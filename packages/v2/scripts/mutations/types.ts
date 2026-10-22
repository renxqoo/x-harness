export interface MutationEdit {
  readonly before: string;
  readonly after: string;
  readonly mode?: "tokens" | "raw";
  readonly expectedMatches?: number;
}

export interface MutationSpan {
  readonly start: number;
  readonly end: number;
}

export interface MutationToken extends MutationSpan {
  readonly kind: number;
  readonly text: string;
}
