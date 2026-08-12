import { Controller, HttpCode, HttpStatus, Param, Post, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators';
import { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import { RepriceService, assertPricedSourcesAvailable } from './reprice.service';

/**
 * Repricing (§6-adjacent): market prices in, asking prices out.
 *
 * The sweep runs nightly on its own (`REPRICE_CRON`); the POST here is the
 * on-demand run, synchronous like on-demand reconciliation — an operator
 * pressing the button wants the report, not a job id.
 */
@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly reprice: RepriceService,
    private readonly registry: CatalogSourceRegistry,
  ) {}

  @Post('sweep')
  @RequireRole('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pull current market prices and reprice under each channel’s policy, now.',
    description:
      'Fetches prices for every allocated item, auto-applies moves within each channel’s ' +
      'threshold, and queues the rest for review. The nightly schedule runs the same code.',
  })
  sweep() {
    assertPricedSourcesAvailable(this.registry);
    return this.reprice.sweep();
  }

  @Get('proposals')
  @RequireRole('viewer')
  @ApiOperation({
    summary: 'Price changes awaiting review.',
    description:
      'Moves larger than a channel’s auto-apply threshold. Each names the product and shows ' +
      'current, proposed and market figures with how the number was arrived at.',
  })
  proposals() {
    return this.reprice.listProposals();
  }

  @Post('proposals/:id/apply')
  @RequireRole('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Apply one proposed price: write it and push it to the channel.' })
  async apply(@Param('id') id: string): Promise<void> {
    await this.reprice.applyProposal(id);
  }

  @Post('proposals/:id/dismiss')
  @RequireRole('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dismiss one proposal.',
    description:
      'Not remembered: the next sweep re-proposes the same change if the market still says so.',
  })
  async dismiss(@Param('id') id: string): Promise<void> {
    await this.reprice.dismissProposal(id);
  }
}
