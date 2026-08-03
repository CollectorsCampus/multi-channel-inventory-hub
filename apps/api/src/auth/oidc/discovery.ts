/**
 * OpenID Connect discovery.
 *
 * A deliberately small amount of hand-written code: fetching a JSON document
 * and checking it says what it must. The dangerous part of OIDC — verifying an
 * ID token's signature against a rotating JWKS — is not here, and is not
 * hand-written; it uses `jose`.
 *
 * The one security property this file owns is **endpoint origin pinning**. A
 * discovery document names the URLs the client will send a client secret and an
 * authorization code to, so an issuer that returned someone else's token
 * endpoint would be redirecting our credentials to them. Every endpoint is
 * therefore required to share an origin with the configured issuer, which is
 * the property an operator actually configured when they set `OIDC_ISSUER_URL`.
 */

export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint?: string;
  /** Signing algorithms the issuer advertises, used to narrow our allow-list. */
  idTokenSigningAlgValuesSupported?: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface RawDiscovery {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  jwks_uri?: unknown;
  end_session_endpoint?: unknown;
  id_token_signing_alg_values_supported?: unknown;
}

/** Where the spec says the document lives, relative to the issuer. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

/**
 * Fetch and validate an issuer's discovery document.
 *
 * Throws with an actionable message on anything unusable. There is no partial
 * success here: a document missing its token endpoint cannot produce a login,
 * and discovering that at the moment a user clicks "sign in" is worse than
 * discovering it now.
 */
export async function fetchDiscovery(
  issuer: string,
  doFetch: FetchLike = (url, init) => fetch(url, init),
  signal?: AbortSignal,
  /** Extra origins the operator accepts endpoints on. See {@link assertSameOrigin}. */
  allowedOrigins: readonly string[] = [],
): Promise<OidcDiscovery> {
  const url = discoveryUrl(issuer);

  let response: Response;
  try {
    response = await doFetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    // `cause` as well as the message: a discovery failure is usually a DNS or
    // TLS problem whose detail lives in the original error, and this is the one
    // point in an OIDC setup where an operator has least to go on.
    throw new Error(
      `Could not reach the identity provider at ${url}: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }

  if (!response.ok) {
    throw new Error(`The identity provider returned HTTP ${response.status} for ${url}.`);
  }

  let body: RawDiscovery;
  try {
    body = (await response.json()) as RawDiscovery;
  } catch {
    throw new Error(`${url} did not return JSON. Check that OIDC_ISSUER_URL is the issuer base.`);
  }

  const issuerClaim = requireString(body.issuer, 'issuer', url);

  /**
   * The issuer must match what was configured, allowing only a trailing-slash
   * difference. This is the check that makes the rest meaningful: it is what
   * ties the document — and therefore every endpoint in it — to the operator's
   * intent rather than to whatever answered the request.
   */
  if (normalizeIssuer(issuerClaim) !== normalizeIssuer(issuer)) {
    throw new Error(
      `The discovery document at ${url} declares issuer "${issuerClaim}", but ` +
        `OIDC_ISSUER_URL is "${issuer}". These must match exactly.`,
    );
  }

  const discovery: OidcDiscovery = {
    issuer: issuerClaim,
    authorizationEndpoint: requireString(
      body.authorization_endpoint,
      'authorization_endpoint',
      url,
    ),
    tokenEndpoint: requireString(body.token_endpoint, 'token_endpoint', url),
    jwksUri: requireString(body.jwks_uri, 'jwks_uri', url),
    ...(typeof body.end_session_endpoint === 'string'
      ? { endSessionEndpoint: body.end_session_endpoint }
      : {}),
    ...(Array.isArray(body.id_token_signing_alg_values_supported)
      ? {
          idTokenSigningAlgValuesSupported: body.id_token_signing_alg_values_supported.filter(
            (alg): alg is string => typeof alg === 'string',
          ),
        }
      : {}),
  };

  assertSameOrigin(discovery, issuerClaim, allowedOrigins);
  return discovery;
}

/**
 * Every endpoint must live on the issuer's own origin, or on one the operator
 * named.
 *
 * Stricter than the specification, which lets an issuer delegate to another
 * host. The reason is the token endpoint: it receives our client secret, so a
 * compromised or hostile discovery document could otherwise harvest it by
 * naming a host of its choosing.
 *
 * **Google made the absolute form of that rule untenable.** Its issuer is
 * `accounts.google.com` while its token endpoint is on `oauth2.googleapis.com`
 * and its JWKS on `www.googleapis.com` — the single most widely deployed
 * provider there is, refused outright. Entra, Auth0, Keycloak and Okta all keep
 * their endpoints on the issuer's origin, so the rule was right about the
 * common case and wrong about the important exception.
 *
 * `allowedOrigins` is the operator saying "I accept that this issuer delegates
 * to these hosts". That keeps the property the rule was protecting — **the
 * operator decides where the client secret may go, not the document** — while
 * letting a real deployment exist. An empty list is the old behaviour exactly.
 */
function assertSameOrigin(
  discovery: OidcDiscovery,
  issuer: string,
  allowedOrigins: readonly string[],
): void {
  const expected = new URL(issuer).origin;
  const permitted = new Set([expected, ...allowedOrigins]);

  const endpoints: Array<[string, string]> = [
    ['authorization_endpoint', discovery.authorizationEndpoint],
    ['token_endpoint', discovery.tokenEndpoint],
    ['jwks_uri', discovery.jwksUri],
  ];

  for (const [name, value] of endpoints) {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new Error(`The discovery document's ${name} ("${value}") is not a valid URL.`);
    }

    if (!permitted.has(origin)) {
      throw new Error(
        `The discovery document's ${name} points at ${origin}, but the issuer is ${expected}. ` +
          `Cross-origin endpoints are refused: the token endpoint receives this client's secret. ` +
          `If this issuer genuinely delegates there, add ${origin} to ` +
          `OIDC_ALLOWED_ENDPOINT_ORIGINS.`,
      );
    }
  }

  // https only, except on loopback where a developer may be running an IdP
  // without a certificate. Anything else would put a client secret and an
  // authorization code on the wire in clear text.
  const url = new URL(discovery.tokenEndpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(
      `The identity provider's token endpoint is ${url.protocol}//${url.host}, which is not ` +
        `HTTPS. This client's secret would be sent in clear text.`,
    );
  }
}

function requireString(value: unknown, field: string, url: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`The discovery document at ${url} has no usable "${field}".`);
  }
  return value;
}

/** Issuers differ only by trailing slash often enough to be worth tolerating. */
function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, '');
}
