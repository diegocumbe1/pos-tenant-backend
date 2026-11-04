import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { ExpenseTemplatesService } from './expense-templates.service';
import { CapitalService } from './capital.service';
import { CashClosingsService } from './cash-closings.service';
import { CashClosingsController } from './cash-closings.controller';
import { PlatformSubscriptionExpenseService } from './platform-subscription-expense.service';

@Module({
  controllers: [FinanceController, CashClosingsController],
  providers: [
    FinanceService,
    ExpenseTemplatesService,
    PlatformSubscriptionExpenseService,
    CapitalService,
    CashClosingsService,
  ],
  // El asistente consulta los gastos por aquí en vez de leer la tabla por su
  // cuenta: el cálculo de un gasto (recurrentes, rangos, categorías) vive en un
  // solo sitio y los dos canales heredan cualquier arreglo.
  exports: [FinanceService],
})
export class FinanceModule {}
