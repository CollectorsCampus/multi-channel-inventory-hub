import { Module } from '@nestjs/common';
import { QueryConsoleController } from './query-console.controller';
import { QueryConsoleService } from './query-console.service';

/**
 * Deliberately depends on nothing.
 *
 * No PrismaModule: the console owns its own connection on a separate read-only
 * role, and importing the application's client is exactly the mistake this
 * feature has to avoid.
 */
@Module({
  controllers: [QueryConsoleController],
  providers: [QueryConsoleService],
})
export class QueryConsoleModule {}
