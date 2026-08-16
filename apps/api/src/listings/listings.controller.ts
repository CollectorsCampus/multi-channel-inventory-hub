import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { ListingCreationService } from './listing-creation.service';
import { ListingImagesService } from './listing-images.service';
import { ListingAttributesService } from './listing-attributes.service';
import {
  BackfillAttributesDto,
  CreateListingsDto,
  IntakeAndListDto,
  ListTagsQueryDto,
  PushListingImagesDto,
} from './listings.dto';

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
  constructor(
    private readonly creation: ListingCreationService,
    private readonly images: ListingImagesService,
    private readonly backfill: ListingAttributesService,
  ) {}

  @Get('attributes/pending')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Linked listings and the tags and custom fields this channel’s rules give them.',
    description:
      'For back-filling rules written after a listing was created. Answered from the ledger, ' +
      'not the platform: these are what the rules resolve to, and applying adds only the tags ' +
      'a listing is actually missing and fills only the custom fields it has none of.',
  })
  pendingAttributes(@Param('id') channelInstanceId: string) {
    return this.backfill.pending(channelInstanceId);
  }

  @Post('attributes/backfill')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Apply the rules’ tags and custom fields to the selected existing listings.',
    description:
      'Tags are additive: one already on the listing, or applied by hand, is left alone. A ' +
      'custom field is only ever filled in where the listing has none, since it holds a ' +
      'single value and overwriting one would discard a hand-picked choice. A listing needing ' +
      'nothing is reported unchanged without a write. Explicit ids only, capped like every ' +
      'other batch of storefront writes.',
  })
  backfillAttributes(
    @Param('id') channelInstanceId: string,
    @Body() body: BackfillAttributesDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return this.backfill.apply(channelInstanceId, body.inventoryItemIds, user.userId);
  }

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

  @Get('publications')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'The sales channels a created product can be published to.',
    description:
      'For choosing which channels created products go on, rather than typing publication ids. ' +
      'Only available on a connector that declares listing.publications.',
  })
  publications(@Param('id') channelInstanceId: string, @Query() query: ListTagsQueryDto) {
    return this.creation.listPublications(channelInstanceId, query.limit);
  }

  @Get('link')
  @RequireRole('viewer')
  @ApiOperation({
    summary: 'Where a listing lives on the channel, as URLs a human can open.',
    description:
      'The storefront page (null while the listing is unpublished) and the platform’s admin ' +
      'page. Viewer-readable: it exposes nothing an id does not already.',
  })
  link(
    @Param('id') channelInstanceId: string,
    @Query('externalListingId') externalListingId: string,
  ) {
    return this.creation.listingUrl(channelInstanceId, externalListingId ?? '');
  }

  @Get('images/pending')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Linked singles whose listing image a re-push could replace.',
    description:
      'What a run would touch, for the operator to pick from. Singles only: sealed listings ' +
      'were created by hand with curated imagery and only matched afterwards, so their images ' +
      'are not this hub’s to replace.',
  })
  pendingImages(@Param('id') channelInstanceId: string) {
    return this.images.pending(channelInstanceId);
  }

  @Post('images/push')
  @RequireRole('editor')
  @ApiOperation({
    summary: 'Replace selected listings’ images with the catalogue’s current ones.',
    description:
      'Destructive of the old image, so it takes explicit inventory item ids — never a filter. ' +
      'Each item is independent: one failure is reported and the rest still land, and ' +
      're-running a selection is harmless.',
  })
  pushImages(
    @Param('id') channelInstanceId: string,
    @Body() body: PushListingImagesDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return this.images.push(channelInstanceId, body.inventoryItemIds, user.userId);
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
