import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { ListingCreationService } from './listing-creation.service';
import { CreateListingsDto, IntakeAndListDto, ListTagsQueryDto } from './listings.dto';

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

  @Get('metafields')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'The custom fields this channel models, and what each accepts.',
    description:
      'For choosing values rather than typing identifiers. A field whose vocabulary could not ' +
      'be read carries an "unavailable" reason instead of empty choices, because on Shopify ' +
      'the failure is a silent null that looks exactly like a store with no entries.',
  })
  metafields(@Param('id') channelInstanceId: string, @Query() query: ListTagsQueryDto) {
    return this.creation.listMetafields(channelInstanceId, query.limit);
  }

  @Post('intake')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Take stock in and list it here, in one call.',
    description:
      'The everyday path for adding cards one at a time. Still one named item, so the rule that ' +
      'a bulk import must not become a storefront full of products is untouched — file imports ' +
      'do not come through here. Listing fields are optional and fall back to the channel’s ' +
      'declared defaults. **The intake stands even if the listing fails**: stock on the shelf ' +
      'is a fact, and it is reported as a problem to retry rather than rolled back.',
  })
  intakeAndList(
    @Param('id') channelInstanceId: string,
    @Body() body: IntakeAndListDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    const { tags, metafields, category, vendor, optionName, price, ...intake } = body;

    return this.creation.intakeAndList({
      ...intake,
      channelInstanceId,
      actorUserId: user.userId,
      ...(tags !== undefined ? { tags } : {}),
      ...(metafields !== undefined ? { metafields } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(vendor !== undefined ? { vendor } : {}),
      ...(optionName !== undefined ? { optionName } : {}),
      ...(price !== undefined ? { price } : {}),
    });
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
      ...(body.metafields !== undefined ? { metafields: body.metafields } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
      ...(body.optionName !== undefined ? { optionName: body.optionName } : {}),
      actorUserId: user.userId,
    });
  }
}
