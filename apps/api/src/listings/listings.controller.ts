import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { ListingCreationService } from './listing-creation.service';
import { CreateListingsDto, ListTagsQueryDto } from './listings.dto';

/**
 * Bringing listings into existence on a channel.
 *
 * The mirror of `channels/:id/match`, which links listings that already exist.
 * Both are `POST` under a channel because both act on one, and neither is
 * something a page load should be able to trigger.
 */
@ApiTags('listings')
@Controller('channels/:id/listings')
export class ListingsController {
  constructor(private readonly creation: ListingCreationService) {}

  @Get('tags')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'The tag vocabulary this channel already uses.',
    description:
      'For choosing tags rather than typing them. A tag that does not already exist on the ' +
      'store usually means a product in no collection, which nothing reports.',
  })
  tags(@Param('id') channelInstanceId: string, @Query() query: ListTagsQueryDto) {
    return this.creation.listTags(channelInstanceId, query.limit);
  }

  @Post()
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Create listings on this channel for selected ledger items.',
    description:
      'Creates as a draft, sets no quantity — stock follows through the normal push path — and ' +
      'records the resulting allocation. One product per card with a variant per condition: an ' +
      'item whose sibling SKU is already listed here becomes a variant of that product. Each ' +
      'item is independent, so one failure is reported and the rest still land. Re-running a ' +
      'selection is safe: the channel is keyed on the SKU code and returns what it already has.',
  })
  create(
    @Param('id') channelInstanceId: string,
    @Body() body: CreateListingsDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return this.creation.create({
      channelInstanceId,
      inventoryItemIds: body.inventoryItemIds,
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
      ...(body.optionName !== undefined ? { optionName: body.optionName } : {}),
      actorUserId: user.userId,
    });
  }
}
