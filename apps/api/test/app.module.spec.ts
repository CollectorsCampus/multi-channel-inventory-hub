import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { SessionService } from '../src/auth/session.service';
import { ApiKeyService } from '../src/auth/api-key.service';
import { AUTH_PROVIDER, type AuthProvider } from '../src/auth/auth-provider.interface';

/**
 * Resolves the entire dependency graph with the database stubbed out.
 *
 * This exists to catch a specific, silent failure mode: NestJS reads
 * constructor dependencies at runtime from `design:paramtypes` metadata, so a
 * provider imported with `import type` (or any build step that drops
 * `emitDecoratorMetadata`) compiles and typechecks perfectly but fails at boot
 * with "Nest can't resolve dependencies". Typechecking cannot see it; only
 * instantiating the container can.
 */

const prismaStub = {
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  user: { count: vi.fn().mockResolvedValue(0) },
  setting: { findFirst: vi.fn().mockResolvedValue(null) },
  session: {},
  apiKey: {},
};

describe('AppModule', () => {
  it('resolves every provider in the dependency graph', async () => {
    // `.compile()` instantiates every provider in the graph — including the
    // globally-registered AuthGuard, which is bound to the APP_GUARD token and
    // so cannot be fetched by class afterwards. If any constructor dependency
    // were unresolvable, this call is where it would throw.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    expect(moduleRef.get(AuthService)).toBeInstanceOf(AuthService);
    expect(moduleRef.get(SessionService)).toBeInstanceOf(SessionService);
    expect(moduleRef.get(ApiKeyService)).toBeInstanceOf(ApiKeyService);

    await moduleRef.close();
  });

  it('injects the local provider behind the AUTH_PROVIDER seam', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    // Swapping this binding is the whole mechanism by which OIDC arrives in
    // v1.x without touching sessions or guards (TECHNICAL_DESIGN.md §8).
    const provider = moduleRef.get<AuthProvider>(AUTH_PROVIDER, { strict: false });
    expect(provider.key).toBe('local');
    expect(provider.supportsDirectLogin).toBe(true);

    await moduleRef.close();
  });
});
