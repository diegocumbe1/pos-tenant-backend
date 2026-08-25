import { Module } from '@nestjs/common';
import { PrintingModule } from '../printing/printing.module';
import {
  PublicReceiptsController,
  ReceiptsController,
  SharedReceiptsController,
} from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [PrintingModule],
  controllers: [ReceiptsController, SharedReceiptsController, PublicReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
