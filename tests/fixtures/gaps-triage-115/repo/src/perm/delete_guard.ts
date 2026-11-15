export function can_delete(user: { has_permission(name: string): boolean }): boolean { return user.has_permission("delete"); }
