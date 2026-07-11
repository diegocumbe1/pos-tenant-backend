import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AddItemsDto } from './dto/add-items.dto';
import { CloseOrderDto } from './dto/close-order.dto';
import { RegisterPaymentDto } from './dto/payment.dto';
import { VoidOrderDto } from './dto/void-order.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'CLOSED'] })
  @ApiQuery({ name: 'tableId', required: false })
  findAll(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('tableId') tableId?: string,
  ) {
    return this.ordersService.findAll(ctx, status ?? 'OPEN', tableId);
  }

  @Get(':id')
  findOne(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.ordersService.findOne(ctx, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentTenant() ctx: TenantContext, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(ctx, dto);
  }

  @Patch(':id/items')
  addItems(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AddItemsDto,
  ) {
    return this.ordersService.addItems(ctx, id, dto);
  }

  @Patch(':id/kitchen')
  sendToKitchen(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.ordersService.sendToKitchen(ctx, id);
  }

  @Patch(':id/payment')
  requestPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: RegisterPaymentDto,
  ) {
    return this.ordersService.requestPayment(ctx, id, dto);
  }

  @Patch(':id/close')
  close(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CloseOrderDto,
  ) {
    return this.ordersService.close(ctx, id, dto);
  }

  @Patch(':id/void')
  voidOrder(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: VoidOrderDto,
  ) {
    return this.ordersService.voidOrder(ctx, id, dto);
  }
}
