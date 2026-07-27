import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, authApi, type AuthStatus, type CurrentUser } from './api/client';

export const authKeys = {
  status: ['auth', 'status'] as const,
  me: ['auth', 'me'] as const,
};

export function useAuthStatus() {
  return useQuery<AuthStatus>({
    queryKey: authKeys.status,
    queryFn: authApi.status,
    staleTime: 30_000,
  });
}

/**
 * The current principal, or null when signed out.
 *
 * A 401 is an expected state here, not an error — it is how the server says
 * "not signed in" — so it resolves to null instead of throwing, and retries are
 * disabled so a signed-out visitor does not trigger a retry storm.
 */
export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: authKeys.me,
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authApi.login(username, password),
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.me, user);
      void queryClient.invalidateQueries({ queryKey: authKeys.status });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authApi.setup(username, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.status }),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    // Drop every cached query, not just the user: cached inventory from the
    // previous session must not survive into the next one.
    onSuccess: () => queryClient.clear(),
  });
}
