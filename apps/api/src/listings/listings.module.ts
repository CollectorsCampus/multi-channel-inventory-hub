import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ListingCreationService } from './listing-creation.service';
import { ListingImagesService } from './listing-images.service';
import { ListingsController } from './listings.controller';

/**
 * Its own module rather than part of `MatchingModule`, although the two are
 * neighbours: matching links listings that exist, this makes ones that do not.
 * Sharing a module would mean sharing `CatalogModule`, which creation does not
 * need — it reads the catalog item the ledger already points at rather than
 * asking a source anything, which is what lets it work for a card no catalogue
 * carries.
 */
@Module({
  imports: [ConnectorsModule, InventoryModule],
  controllers: [ListingsController],
  providers: [ListingCreationService, ListingImagesService],
  exports: [ListingCreationService],
})
export class ListingsModule {}
