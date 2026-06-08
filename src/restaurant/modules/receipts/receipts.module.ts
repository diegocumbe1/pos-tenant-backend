import { Module } from '@nestjs/common';
import { PrintingModule } from '../printing/printing.module';
import {
  PublicReceiptsController,
  ReceiptsController,
} from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [PrintingModule],
  controllers: [ReceiptsController, PublicReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
