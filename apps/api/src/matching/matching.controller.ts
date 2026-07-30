import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { MatchingService } from './matching.service';
import { ConfirmMatchesDto, ProposeMatchesDto } from './matching.dto';

/**
 * Linking a channel's existing listings to the ledger (§7).
 *
 * `POST` for proposing as well as confirming, although proposing changes nothing.
 * It takes a body rather than a query string because it names a set and a source
 * and pages through a channel, and it can spend real time doing it — a `GET` that
 * downloads a set file and walks a Shopify page is not the cacheable, idempotent
 * read a `GET` promises to be.
 */
@ApiTags('matching')
@Controller('channels/:id/match')
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Post('propose')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Propose links between this channel’s existing listings and one set.',
    description:
      'Proposes only; nothing is written. Listings that already have an allocation on this ' +
      'channel are skipped. A tie between candidates is reported as ambiguous rather than ' +
      'resolved, so the operator decides.',
  })
  propose(@Param('id') channelInstanceId: string, @Body() body: ProposeMatchesDto) {
    return this.matching.propose({ channelInstanceId, ...body });
  }

  @Post('confirm')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Apply confirmed links.',
    description:
      'Each link is independent: one failure is reported and the rest still land. ' +
      'Re-confirming an identical link is a no-op. Creates the catalog item, SKU and ' +
      'inventory row if they do not exist, with no stock — linking is identity, not intake.',
  })
  confirm(
    @Param('id') channelInstanceId: string,
    @Body() body: ConfirmMatchesDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return this.matching.confirm(channelInstanceId, body.links, user.userId);
  }
}
