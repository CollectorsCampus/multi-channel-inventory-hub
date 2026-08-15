import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators';
import { apiVersion } from '../version';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Process is up. Does not touch dependencies.' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * What is actually running, for the settings screen.
   *
   * Deliberately **not** `@Public()`, unlike the probes: the version narrows
   * which advisories apply to a deployment, and an unauthenticated reader has
   * no reason to need it. Anyone signed in can see it, which is who the
   * settings page is for. (It reaches `/api/health/version` — only the two
   * probes are excluded from the global prefix.)
   */
  @Get('version')
  @ApiOperation({ summary: 'The running server’s version, from its own manifest.' })
  version(): { version: string } {
    return { version: apiVersion() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Dependencies are reachable. Use for container readiness.' })
  async ready(): Promise<{ status: 'ok' | 'degraded'; database: 'up' | 'down' }> {
    // A trivial indexed read rather than $queryRaw — raw SQL is banned in core
    // and would differ per dialect anyway (TECHNICAL_DESIGN.md §3).
    try {
      await this.prisma.setting.findFirst({ select: { key: true } });
      return { status: 'ok', database: 'up' };
    } catch {
      return { status: 'degraded', database: 'down' };
    }
  }
}
