import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicSiteService } from '../public-site/barber-public-site.service';
import { BarberPublicService } from './barber-public.service';
import {
  CreatePublicAppointmentDto,
  PublicAvailabilityQueryDto,
  PublicSpecialistsQueryDto,
} from './dto/public-appointment.dto';

@ApiTags('PublicBarber')
@Controller('public/barber')
export class BarberPublicController {
  constructor(
    private readonly publicService: BarberPublicService,
    private readonly publicSiteService: PublicSiteService,
  ) {}

  @Get('sites/:slug')
  @Header('Cache-Control', 'public, max-age=60')
  getSite(@Param('slug') slug: string) {
    return this.publicSiteService.getPublicSiteBySlug(slug);
  }

  @Get('branches/:slug')
  @Header('Cache-Control', 'public, max-age=60')
  getProfile(@Param('slug') slug: string) {
    return this.publicService.getProfile(slug);
  }

  @Get('branches/:branchId/services')
  @Header('Cache-Control', 'public, max-age=60')
  listServices(@Param('branchId') branchId: string) {
    return this.publicService.listServices(branchId);
  }

  @Get('branches/:branchId/specialists')
  @Header('Cache-Control', 'public, max-age=60')
  listSpecialists(
    @Param('branchId') branchId: string,
    @Query() query: PublicSpecialistsQueryDto,
  ) {
    return this.publicService.listSpecialists(branchId, query.serviceId);
  }

  @Get('branches/:branchId/availability')
  getAvailability(
    @Param('branchId') branchId: string,
    @Query() query: PublicAvailabilityQueryDto,
  ) {
    return this.publicService.getAvailability(branchId, query);
  }

  @Post('branches/:branchId/appointments')
  createAppointment(
    @Param('branchId') branchId: string,
    @Body() dto: CreatePublicAppointmentDto,
  ) {
    return this.publicService.createAppointment(branchId, dto);
  }
}
