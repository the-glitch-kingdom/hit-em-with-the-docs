export const SLUG_MAX_LENGTH = 72;
export function slugify_title(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, SLUG_MAX_LENGTH); }
