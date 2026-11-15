export function check_delete_permission(user: User): boolean { return user.has_permission('delete'); }
