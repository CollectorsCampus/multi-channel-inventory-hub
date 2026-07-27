import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators';

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
