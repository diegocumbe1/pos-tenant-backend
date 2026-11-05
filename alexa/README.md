# Modelo de interacción de Alexa

`interaction-model.json` es la **fuente única**, y es el modelo de la skill de
plataforma. Una prueba lo compara contra el `switch` de `alexa.service.ts`.

## Generar el modelo

```bash
# Skill de plataforma: tal cual, solo cambia el nombre de invocación si se pide.
npm run --silent alexa:model > lynko.json

# Skill de un negocio: sin slot de negocio ni intents de plataforma.
npm run --silent alexa:model -- --tenant --name "mi panel de belleza" > bella-chic.json
```

Pega la salida en la consola de Amazon, en **Build → Interaction Model → JSON
Editor**, y haz **Save** y **Build** en cada idioma de la skill.

## Agregar un intent

1. Agrégalo en `interaction-model.json`.
2. Agrégalo en el `switch` de `alexa.service.ts`, dentro de `guarded()` o
   `forBusiness()`. Si falta uno de los dos, la prueba falla.
3. Regenera el modelo de cada skill y publícalo.

Las skills de negocio no llevan `{negocio}`: la skill es el negocio.
