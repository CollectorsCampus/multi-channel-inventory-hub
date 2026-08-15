import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Single sign-on configuration, editable after first-run.
 *
 * Every field carries `managedByEnv`. Where that is true the environment
 * declared it, the server refuses to change it, and the form disables the
 * input — so what looks editable is exactly what the endpoint controls. That is
 * the property the settings screen was kept read-only to protect, preserved
 * rather than traded away.
 */

export type OidcField =
  | 'enabled'
  | 'issuer'
  | 'clientId'
  | 'clientSecret'
  | 'scopes'
  | 'roleClaim'
  | 'roleMap'
  | 'defaultRole'
  | 'allowLocalLogin'
  | 'allowedEndpointOrigins';

export interface OidcFieldView {
  value: string;
  managedByEnv: boolean;
}

export interface OidcSettingsView {
  fields: Record<OidcField, OidcFieldView>;
  /** Whether a secret is stored. Never the secret. */
  clientSecretSet: boolean;
  redirectUri: string;
}

export interface OidcSettingsPatch {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  /** Omit to keep the stored one; "" clears it. */
  clientSecret?: string;
  scopes?: string;
  roleClaim?: string;
  roleMap?: string;
  defaultRole?: 'viewer' | 'editor' | 'admin';
  allowLocalLogin?: boolean;
  allowedEndpointOrigins?: string;
}

export interface OidcTestResult {
  ok: true;
  issuer: string;
  endpoints: string[];
}

export function useOidcSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['settings', 'oidc'],
    queryFn: () => apiFetch<OidcSettingsView>('/settings/oidc'),
    enabled,
    // Admin-only: a non-admin gets a 403 that retrying cannot fix.
    retry: false,
  });
}

export function useUpdateOidcSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OidcSettingsPatch) =>
      apiFetch<OidcSettingsView>('/settings/oidc', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    // Enabling SSO changes what the login screen offers, which `/auth/status`
    // reports — so that has to be refetched or the change is invisible until a
    // reload.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'oidc'] });
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
  });
}

/**
 * Fetch the issuer's discovery document without saving.
 *
 * Worth its own action because the alternative is finding out at the redirect,
 * on the provider's error page, where it reads as the provider being broken.
 */
export function useTestOidcSettings() {
  return useMutation({
    mutationFn: (body: OidcSettingsPatch) =>
      apiFetch<OidcTestResult>('/settings/oidc/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Remote syslog: where alerts and sync activity are shipped as RFC 5424. */
export interface SyslogSettings {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
}

export function useSyslogSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['settings', 'syslog'],
    queryFn: () => apiFetch<SyslogSettings>('/settings/syslog'),
    enabled,
    retry: false,
  });
}

export function useUpdateSyslogSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SyslogSettings>) =>
      apiFetch<SyslogSettings>('/settings/syslog', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'syslog'] });
    },
  });
}

/**
 * Sends one test message with the *saved* settings — save first. TCP reports
 * delivery honestly; UDP can only ever say "sent".
 */
export function useTestSyslog() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; detail: string }>('/settings/syslog/test', { method: 'POST' }),
  });
}

/** Email alerting: SMTP settings plus the severity threshold. */
export interface EmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  to: string;
  threshold: 'critical' | 'warning' | 'info';
  /** Whether a password is stored — never the password. */
  passwordSet: boolean;
}

export type EmailSettingsPatch = Partial<Omit<EmailSettings, 'passwordSet'>> & {
  /** Omit to keep the stored one; empty string clears it. */
  password?: string;
};

export function useEmailSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['settings', 'email'],
    queryFn: () => apiFetch<EmailSettings>('/settings/email'),
    enabled,
    retry: false,
  });
}

export function useUpdateEmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EmailSettingsPatch) =>
      apiFetch<EmailSettings>('/settings/email', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'email'] });
    },
  });
}

/** Sends a real email with the *saved* settings — save first. */
export function useTestEmail() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; detail: string }>('/settings/email/test', {
        method: 'POST',
        body: '{}',
      }),
  });
}

/**
 * The running server's version.
 *
 * Read from the API rather than baked into the bundle: the API is what is
 * actually deployed, and in the dev instance the two halves can legitimately
 * differ. Effectively immutable for the life of a page, so it never refetches.
 */
export function useServerVersion() {
  return useQuery({
    queryKey: ['health', 'version'],
    queryFn: () => apiFetch<{ version: string }>('/health/version'),
    staleTime: Infinity,
    retry: false,
  });
}
