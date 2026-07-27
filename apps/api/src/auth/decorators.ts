import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@hub/db';
import type { AuthenticatedPrincipal } from './auth-provider.interface';

export const IS_PUBLIC_KEY = 'auth:public';
export const REQUIRED_ROLE_KEY = 'auth:requiredRole';

/**
 * Opt a route out of authentication. The guard is registered globally and
 * fails closed, so every unauthenticated route must say so explicitly.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum role required. Roles are ordered viewer < editor < admin, so
 * `@RequireRole('editor')` also admits admins.
 */
export const RequireRole = (role: UserRole) => SetMetadata(REQUIRED_ROLE_KEY, role);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal | undefined =>
    ctx.switchToHttp().getRequest().principal,
);
