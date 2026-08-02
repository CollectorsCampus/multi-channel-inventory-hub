import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequireRole } from '../auth/decorators';
import type { AuthenticatedPrincipal } from '../auth/auth-provider.interface';
import { InventoryService } from './inventory.service';
import { IntakeService } from './intake.service';
import {
  AdjustQuantityDto,
  AllocationWriteDto,
  CreateInventoryItemDto,
  IntakeDto,
  ListInventoryQueryDto,
  PreviewLedgerDto,
  SetReserveDto,
} from './inventory.dto';

/**
 * Inventory REST surface (§7).
 *
 * Reads need `viewer`; anything that moves a quantity needs `editor`. The guard
 * is global and fails closed, so every route here is authenticated — the UI
 * only reflects permissions, it never enforces them (§8).
 */
@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly intakeService: IntakeService,
  ) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Browse inventory: paginated, filtered and sorted server-side.' })
  list(@Query() query: ListInventoryQueryDto) {
    return this.inventory.listInventory(query);
  }

  @Post()
  @RequireRole('editor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a catalog item, SKU and inventory row together.' })
  create(@Body() body: CreateInventoryItemDto, @CurrentUser() user: AuthenticatedPrincipal) {
    return this.inventory.createInventoryItem({ ...body, actorUserId: user.userId });
  }

  /**
   * Catalog result to stock on the shelf.
   *
   * Lands as unallocated: recording that stock exists is a separate act from
   * deciding where it goes. Intaking the same SKU again adds to it rather than
   * creating a second row.
   */
  @Post('intake')
  @RequireRole('editor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add stock from a catalog product. Lands unallocated.' })
  intake(@Body() body: IntakeDto, @CurrentUser() user: AuthenticatedPrincipal) {
    return this.intakeService.intake({ ...body, actorUserId: user.userId });
  }

  /**
   * Declared before `:id`, or Nest would match "games" as an item id and
   * answer 404 for a route that exists.
   */
  @Get('games')
  @RequireRole('viewer')
  @ApiOperation({
    summary: 'Games present in the ledger, with counts, for a filter.',
    description:
      'Derived from what is actually held rather than from what the catalog sources declare, ' +
      'so the list can never offer a game that would return nothing. A null game is real and ' +
      'is reported: it is what non-TCG goods and hand-entered items have.',
  })
  games() {
    return this.inventory.listGames();
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'One inventory item with its allocations and derived quantities.' })
  get(@Param('id') id: string) {
    return this.inventory.getLedger(id);
  }

  /**
   * Dry run. Returns the pool, per-channel listed quantities and every rule
   * violation for a hypothetical ledger, without writing anything.
   *
   * POST rather than GET because the proposal is a structured body, not a
   * filter. It is nullipotent despite the verb.
   */
  @Post(':id/preview')
  @RequireRole('viewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a proposed ledger without saving it.' })
  preview(@Param('id') id: string, @Body() body: PreviewLedgerDto) {
    return this.inventory.previewLedger(id, body);
  }

  @Post(':id/adjust')
  @RequireRole('editor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move physical stock by a signed delta, recording a stock movement.' })
  adjust(
    @Param('id') id: string,
    @Body() body: AdjustQuantityDto,
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return this.inventory.adjustQuantityOnHand(id, body.delta, {
      reason: body.reason,
      note: body.note,
      actorUserId: user.userId,
    });
  }

  @Put(':id/reserve')
  @RequireRole('editor')
  @ApiOperation({ summary: 'Set stock held back from every pooled listing.' })
  setReserve(@Param('id') id: string, @Body() body: SetReserveDto) {
    return this.inventory.setReserveQuantity(id, body.reserveQuantity);
  }

  @Put(':id/allocations')
  @RequireRole('editor')
  @ApiOperation({ summary: 'Create or update one channel allocation.' })
  upsertAllocation(@Param('id') id: string, @Body() body: AllocationWriteDto) {
    return this.inventory.upsertAllocation(id, body);
  }

  @Delete(':id/allocations/:channelInstanceId')
  @RequireRole('editor')
  @ApiOperation({ summary: 'Remove a channel allocation, returning its stock to the pool.' })
  removeAllocation(@Param('id') id: string, @Param('channelInstanceId') channelInstanceId: string) {
    return this.inventory.removeAllocation(id, channelInstanceId);
  }
}
