import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * User administration.
 *
 * Admin-only on the server; the links are shown regardless and the page
 * explains the restriction, which is the same rule the channels screen follows
 * (§8: the UI reflects permissions, it never enforces them).
 */

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  provider: string;
  isActive: boolean;
  /** Whether this account can sign in with a password. Never the hash. */
  hasPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const USER_ROLES: readonly UserRole[] = ['admin', 'editor', 'viewer'];

/** What each role may do, in the operator's terms rather than the guard's. */
export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Everything, including channels, credentials and users.',
  editor: 'Add stock, allocate it, and list it on a channel.',
  viewer: 'Read everything, change nothing.',
};

const usersKey = ['users'] as const;

export function useUsers() {
  return useQuery({
    queryKey: usersKey,
    queryFn: () => apiFetch<User[]>('/users'),
    // An admin-only list on a screen a non-admin can reach: one 403 is the
    // answer, not something to retry into.
    retry: false,
  });
}

function useUsersMutation<TArgs>(request: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: usersKey }),
  });
}

export function useCreateUser() {
  return useUsersMutation(
    (body: {
      username: string;
      password: string;
      role: UserRole;
      email?: string;
      displayName?: string;
    }) => apiFetch<User>('/users', { method: 'POST', body: JSON.stringify(body) }),
  );
}

export function useUpdateUser() {
  return useUsersMutation(({ id, ...body }: { id: string; role?: UserRole; isActive?: boolean }) =>
    apiFetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  );
}

export function useSetUserPassword() {
  return useUsersMutation(({ id, password }: { id: string; password: string }) =>
    apiFetch<void>(`/users/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  );
}

export function useDeleteUser() {
  return useUsersMutation((id: string) => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }));
}
