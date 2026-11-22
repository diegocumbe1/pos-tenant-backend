import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../../shared/barber-shared.module';
import { PlayMundialAdminController } from './playmundial-admin.controller';
import { PlayMundialCatalogService } from './playmundial-catalog.service';
import { PlayMundialLinkService } from './playmundial-link.service';
import { PlayMundialOccurrencesService } from './playmundial-occurrences.service';
import { PlayMundialTokenGuard } from './playmundial-token.guard';
import { PlayMundialController } from './playmundial.controller';

@Module({
  imports: [BarberSharedModule],
  controllers: [PlayMundialController, PlayMundialAdminController],
  providers: [
    PlayMundialLinkService,
    PlayMundialCatalogService,
    PlayMundialOccurrencesService,
    PlayMundialTokenGuard,
  ],
})
export class PlayMundialModule {}
