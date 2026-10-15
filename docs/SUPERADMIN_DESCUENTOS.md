# Descuentos a clientes — guía del super-admin

Cómo registrar en la consola (`admin.uselynko.com`) un descuento o un precio especial para un cliente, de forma que Finanzas, los cobros y el histórico lo reflejen bien.

---

## 1. Tres conceptos

| Concepto | Qué es | De dónde sale |
|---|---|---|
| **Precio oficial** (lista) | La tarifa del plan para el vertical del cliente | **Planes y precios** (`/admin/pricing`), en USD convertido a COP con la tasa vigente |
| **Precio aplicado** (pactado) | Lo que efectivamente se le cobra al cliente | Lo decides tú en la suscripción del cliente |
| **Descuento** | Oficial − aplicado | Se calcula solo, no se escribe |

> **Regla de oro:** el precio oficial **siempre es la tarifa**. El descuento se registra bajando el **precio aplicado**, nunca bajando el oficial.

Si escribes el precio con descuento como oficial, el sistema cree que el cliente paga la tarifa completa: el descuento no aparece en Finanzas y, si cambias la tarifa, nadie sabrá que ese cliente tenía un trato especial.

---

## 2. Registrar un descuento

**Ruta:** Cuentas → *cliente* → pestaña **Suscripción** → bloque **Resumen financiero**.

1. **Precio oficial COP**: déjalo en la tarifa vigente. Compáralo con *Planes y precios*: vertical del cliente, plan actual, columna `≈ $`.
2. **Precio aplicado COP**: lo que le vas a cobrar.
3. **Tipo de descuento**: elige uno:
   - *Bono de bienvenida*: primeros meses de un cliente nuevo.
   - *Promoción*: campaña u oferta puntual.
   - *Fidelidad*: premio por antigüedad.
   - *Aliado*: socio, referidor o convenio.
   - *Manual*: cualquier otro caso (explícalo en el motivo).
4. **Motivo descuento**: una frase que alguien entienda dentro de seis meses. Bien: *"Oferta de lanzamiento acordada por WhatsApp el 15/10"*. Mal: *"desc"*.
5. **Vigente hasta** (opcional): si el descuento es temporal, la fecha en que termina. Déjalo vacío si es permanente (por ejemplo, un precio de cliente fundador).
6. **Guardar** y confirmar.

**Cómo verificar:** el resumen debe mostrar las tres tarjetas coherentes.

```
PRECIO OFICIAL   $ 82.500
DESCUENTO        − $ 12.500  (15%)   Promoción
PRECIO ACTUAL    $ 70.000
```

Si la tarjeta *Descuento* muestra `—` y le diste descuento, quedó mal registrado: revisa que el oficial sea la tarifa.

---

## 3. Casos frecuentes

### Descuento en porcentaje
"Te dejo el Pro de barbería con 20%". Tarifa $82.500 → aplicado = 82.500 × 0,80 = **$66.000**. Tipo *Promoción*. Escribe el porcentaje en el motivo.

### Precio fijo especial (cliente fundador)
"Te lo dejo en $92.000 para siempre". Oficial = tarifa ($109.000), aplicado = **$92.000**, tipo *Fidelidad* o *Manual*, motivo *"Precio fundador"*, sin fecha de fin.

### Bono temporal
"Los primeros 3 meses a mitad de precio". Aplicado = 50% de la tarifa, tipo *Bono de bienvenida*, **Vigente hasta** = fin del tercer mes. Al vencer, vuelve a la suscripción y deja el aplicado igual al oficial (ver §6).

### Meses gratis o cortesía
Eso **no** es un descuento en el precio: es un periodo regalado. Regístralo en **Pagos** como *bono/cortesía* con el periodo cubierto. No suma a ingresos y deja rastro del motivo. El precio pactado no se toca.

### Pago anticipado (3, 6 o 12 meses)
No se registra aquí. El descuento por pago anticipado se configura en *Planes y precios → Descuento por pago anticipado* y se aplica **sobre el precio aplicado** del cliente. Si el cliente ya tiene un descuento, ambos se acumulan: primero el pactado, luego el de pago anticipado.

---

## 4. Registrar los pagos de un cliente con descuento

En la pestaña **Pagos → Registrar pago**:

| Campo | Qué poner |
|---|---|
| **Precio de lista** | Tarifa mensual × **meses que cubre el pago**. Es obligatorio en la práctica, ver abajo. |
| **Monto cobrado** | Lo que realmente entró a la cuenta |
| **Motivo del descuento** | Aparece cuando lista > monto. Explica el trato. |
| **Periodo** | Desde / hasta lo que cubre el pago |

> ⚠️ **Si dejas *Precio de lista* vacío, el formulario usa el monto cobrado como lista**, y el pago queda registrado **sin descuento**. Así, Finanzas registra la tarifa completa como cobrada y el descuento desaparece.

Ejemplo, pago anticipado de 4 meses de barbería Pro (tarifa $82.500) con 50% de bienvenida:
- Precio de lista: 82.500 × 4 = **330.000**
- Monto cobrado: **165.000**
- Motivo: *"Bienvenida 50% por 4 meses, pago anticipado"*
- Periodo: 4 meses

Si además se regala un mes, regístralo **aparte** como *Bono / cortesía* con su propio periodo, con precio de lista de un mes y monto 0.

En Finanzas el descuento aparece como *ingreso que se dejó de percibir*, no como gasto.

---

## 5. Qué pasa si cambias el plan

Al usar **Cambiar plan** en la suscripción:

- **Sin descuento:** el oficial y el aplicado pasan solos a la tarifa del nuevo plan.
- **Con descuento:** el oficial pasa a la nueva tarifa, pero **el aplicado se conserva**, porque es un acuerdo que hiciste tú. Revisa si ese precio sigue teniendo sentido con el nuevo plan y ajústalo a mano (§2).

## 6. Terminar o cambiar un descuento

- **Quitarlo:** pon *Precio aplicado = Precio oficial*, tipo *Sin descuento*, y guarda.
- **Cambiarlo:** edita el aplicado, el tipo y el motivo, y guarda.

Cada cambio queda en el **Historial** de la cuenta (quién, cuándo, antes/después). Los pagos ya registrados no se modifican.

## 7. Qué pasa si sube la tarifa

Cuando cambias un precio en *Planes y precios*, **no se toca ninguna suscripción existente**: ni el oficial ni el aplicado. Los pagos ya registrados tampoco cambian. Las cuentas nuevas sí nacen con la tarifa nueva.

Para pasarle la nueva tarifa a un cliente existente, edita su suscripción. Si tiene descuento, actualiza solo el *Precio oficial* y conserva el aplicado. Si no tiene, actualiza ambos.

---

## 8. Errores a evitar

| ❌ No hagas | ✅ Haz |
|---|---|
| Poner el precio con descuento como *Precio oficial* | Oficial = tarifa; descuento en el *Precio aplicado* |
| Descuento sin motivo | Siempre tipo y motivo |
| Regalar un mes bajando el precio a $0 | Registrar un pago tipo *bono/cortesía* |
| Dejar un bono temporal sin fecha y olvidarlo | Poner *Vigente hasta* y revisarlo al vencer |
| Registrar el pago por la tarifa cuando pagó menos | Monto del pago = lo que realmente entró |
| Dejar vacío *Precio de lista* al registrar un pago con descuento | Lista = tarifa mensual × meses cubiertos |

## Checklist rápido

- [ ] Oficial = tarifa del vertical y del plan (comparado con *Planes y precios*)
- [ ] Aplicado = precio acordado con el cliente
- [ ] Tipo y motivo claros
- [ ] Fecha de fin si es temporal
- [ ] La tarjeta *Descuento* del resumen muestra el monto y el %

---

> **Estado actual (15/10/2026):** guardar un descuento desde el formulario puede fallar (error 400), porque el backend todavía no acepta los campos *Tipo de descuento* y *Vigente hasta*. Mientras eso se corrige, no registres el descuento bajando el precio oficial. Déjalo anotado y regístralo cuando el arreglo esté en producción. Además, *Vigente hasta* por ahora solo informa: el descuento **no** se retira solo al vencer.
