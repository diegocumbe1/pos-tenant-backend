import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PlayMundialCatalogService } from './playmundial-catalog.service';
import { PlayMundialAccess } from './playmundial-link.service';
import { PlayMundialOccurrencesService } from './playmundial-occurrences.service';
import {
  PlayMundialAccessParam,
  PlayMundialTokenGuard,
} from './playmundial-token.guard';

class OccurrencesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  courtId?: string;
}

class SummaryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;
}

/**
 * Lo que Play Mundial consulta. Solo lectura, y solo de la sede dueña del
 * token. Contrato v1: ver docs/PLAN_CANCHAS_MARCADOR_Y_FIDELIZACION.md §5.3.
 */
@ApiTags('Integrations')
@ApiBearerAuth()
@UseGuards(PlayMundialTokenGuard)
@Controller('integrations/playmundial/v1')
export class PlayMundialController {
  constructor(
    private readonly occurrences: PlayMundialOccurrencesService,
    private readonly catalog: PlayMundialCatalogService,
  ) {}

  @Get('courts')
  courts(@PlayMundialAccessParam() access: PlayMundialAccess) {
    return this.catalog.courts(access);
  }

  @Get('customers/summary')
  customersSummary(
    @PlayMundialAccessParam() access: PlayMundialAccess,
    @Query() query: SummaryQueryDto,
  ) {
    return this.catalog.customersSummary(access, query);
  }

  @Get('occurrences')
  list(
    @PlayMundialAccessParam() access: PlayMundialAccess,
    @Query() query: OccurrencesQueryDto,
  ) {
    return this.occurrences.list(access, query);
  }
}
