export const SYNC_BATCH_LIMIT = 40;
export function can_edit(user: { has_role(name: string): boolean }): boolean { return user.has_role("editor"); }
